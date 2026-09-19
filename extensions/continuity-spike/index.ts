import { randomUUID } from "node:crypto";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createContextHost } from "./src/context-host.js";
import { ContinuityEngine, ContinuityError, DestinationFixture } from "./src/engine.js";
import { continuityRpcError } from "./src/rpc-errors.js";
import {
  count,
  direction,
  flag,
  operation,
  receipt,
  revision,
  shape,
  text,
} from "./src/rpc-input.js";
import { cancelScheduledTurn, type ScheduledTurn } from "./src/scheduled-turn.js";
import { requireCondition as requireValue } from "./src/state-helpers.js";
import type { ActivityPolicy, ActivityState, DestinationState } from "./src/types.js";

type Role = "home" | "company" | "family";
type RunBinding = { activityId: string; sessionKey: string; runId: string; jobId?: string };
type CallBinding = RunBinding & { signal?: AbortSignal };
type HeldCall = RunBinding & { release: () => void; cancel: () => void };
function failure(error: unknown): string {
  return error instanceof ContinuityError ? error.code : "continuity-spike-unavailable";
}
declare const hookRegistration: OpenClawPluginApi["on"];
type Controller = {
  isRunning: () => boolean;
  execute: (
    sessionKey: string,
    toolCallId: string,
    signal?: AbortSignal,
  ) => ReturnType<AnyAgentTool["execute"]>;
  beforePrompt: Parameters<typeof hookRegistration<"before_prompt_build">>[1];
  beforeRun: Parameters<typeof hookRegistration<"before_agent_run">>[1];
  beforeTool: Parameters<typeof hookRegistration<"before_tool_call">>[1];
  agentEnd: Parameters<typeof hookRegistration<"agent_end">>[1];
};
const runtimeStore = createPluginRuntimeStore<Controller>({
  pluginId: "continuity-spike",
  errorMessage: "continuity-spike-service-not-running",
});
export default definePluginEntry({
  id: "continuity-spike",
  name: "Continuity Spike",
  description: "Synthetic persistent-agent lifecycle experiment",
  register(api: OpenClawPluginApi) {
    let running = false;
    let retired = false;
    let role: Role | undefined;
    let meta: PluginStateSyncKeyedStore<{ role: Role }> | undefined;
    let engine: ContinuityEngine | undefined;
    let destination: DestinationFixture | undefined;
    const runs = new Map<string, RunBinding>();
    const calls = new Map<string, CallBinding>();
    const holds = new Set<string>();
    const held = new Map<string, HeldCall>();
    const scheduled = new Map<string, ScheduledTurn>();
    const pendingSchedules = new Set<Promise<unknown>>();
    let generation = 0;
    let stopping: Promise<void> | undefined;
    const enrolledSessions = new Set<string>();
    const runKey = (sessionKey: string, runId: string) => `${sessionKey}\u0000${runId}`;
    const callKey = (sessionKey: string, toolCallId: string) => `${sessionKey}\u0000${toolCallId}`;
    const requireRunning = () =>
      requireValue(
        running && !retired && runtimeStore.tryGetRuntime() === controller,
        "service-not-running",
      );
    const home = () => {
      requireRunning();
      requireValue(role === "home" && engine, "home-role-required");
      return engine;
    };
    const remote = () => {
      requireRunning();
      requireValue(
        (role === "company" || role === "family") && destination,
        "destination-role-required",
      );
      return destination;
    };
    const findActivity = (sessionKey: string): ActivityState | undefined => {
      if (!running || role !== "home" || !engine) {
        return undefined;
      }
      const matches = engine.list().filter((activity) => activity.sessionKey === sessionKey);
      requireValue(matches.length <= 1, "ambiguous-session-activity");
      return matches[0];
    };
    const openRole = () => {
      if (role === "home") {
        engine = new ContinuityEngine(
          api.runtime.state.openSyncKeyedStore<ActivityState>({
            namespace: "home",
            maxEntries: 16,
            overflowPolicy: "reject-new",
          }),
        );
        for (const activity of engine.list()) {
          enrolledSessions.add(activity.sessionKey);
        }
      } else if (role === "company" || role === "family") {
        destination = new DestinationFixture(
          api.runtime.state.openSyncKeyedStore<DestinationState>({
            namespace: `destination-${role}`,
            maxEntries: 16,
            overflowPolicy: "reject-new",
          }),
          role,
        );
      }
    };
    const cancelSchedule = (job: ScheduledTurn) => cancelScheduledTurn(job, api.session.workflow);
    const schedule = (id: string) => {
      const activity = home().get(id);
      requireValue(
        !activity.stopped && activity.attachment.connected && activity.policy.execute,
        "activity-not-eligible",
      );
      requireValue(
        activity.status !== "completed" && activity.status !== "blocked",
        "activity-not-eligible",
      );
      requireValue(
        !activity.operations.some(
          (record) =>
            record.state === "admitted" ||
            record.state === "dispatched" ||
            record.state === "outcome-unknown",
        ),
        "operation-pending",
      );
      const existing = scheduled.get(id);
      if (existing) {
        requireValue(!existing.cancelled, "scheduled-turn-cleanup-required");
        return Promise.resolve({ scheduled: true, coalesced: true });
      }
      requireValue(
        scheduled.size < 16 && pendingSchedules.size < 16,
        "schedule-capacity-exhausted",
      );
      const job: ScheduledTurn = {
        sessionKey: activity.sessionKey,
        // Public cancellation is tag-scoped. Never share a tag with a later service owner.
        tag: `continuity-${randomUUID()}`,
        generation,
        cancelled: false,
        // Scheduling can create a job and then return no handle (failed rollback).
        cleanupRequired: true,
      };
      scheduled.set(id, job);
      const task = (async () => {
        try {
          try {
            job.handle = await api.session.workflow.scheduleSessionTurn({
              sessionKey: activity.sessionKey,
              message: "tool search qa check target=continuity_advance",
              delayMs: 500,
              deleteAfterRun: true,
              deliveryMode: "none",
              // "continuation" is a retry marker in the maintained mock provider.
              name: "Continuity spike step",
              tag: job.tag,
            });
          } catch (error) {
            await cancelSchedule(job);
            throw error;
          }
          const cancelled =
            job.cancelled ||
            job.generation !== generation ||
            !running ||
            runtimeStore.tryGetRuntime() !== controller;
          if (cancelled || !job.handle) {
            await cancelSchedule(job);
            throw new ContinuityError(
              cancelled ? "service-not-running" : "native-session-scheduler-unavailable",
            );
          }
          return { scheduled: true, jobId: job.handle.id };
        } catch (error) {
          if (!job.cleanupRequired && scheduled.get(id) === job) {
            scheduled.delete(id);
          }
          throw error;
        }
      })();
      job.pending = task;
      pendingSchedules.add(task);
      void task
        .finally(() => {
          pendingSchedules.delete(task);
          job.pending = undefined;
        })
        .catch(() => {});
      return task;
    };
    const clearRun = (binding: RunBinding) => {
      runs.delete(runKey(binding.sessionKey, binding.runId));
      for (const [key, call] of calls) {
        if (call.sessionKey === binding.sessionKey && call.runId === binding.runId) {
          calls.delete(key);
        }
      }
      for (const gate of held.values()) {
        if (gate.sessionKey === binding.sessionKey && gate.runId === binding.runId) {
          gate.cancel();
        }
      }
    };
    // Discovery never opens state. Arguments never carry authority.
    api.registerTool(
      (ctx): AnyAgentTool => ({
        name: "continuity_advance",
        label: "Advance synthetic activity",
        description:
          "Propose the next eligible synthetic step for this enrolled turn. No arguments. The host chooses the activity, direction, and target. This does not dispatch a remote effect.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(toolCallId, _params, signal) {
          requireValue(ctx.sessionKey, "exact-session-binding-required");
          return runtimeStore.getRuntime().execute(ctx.sessionKey, toolCallId, signal);
        },
      }),
      { name: "continuity_advance", optional: true },
    );
    // Hook registration is declarative and must survive discovery-only agent registry loads.
    api.on("before_prompt_build", (event, ctx) =>
      runtimeStore.tryGetRuntime()?.beforePrompt(event, ctx),
    );
    api.on("before_agent_run", (event, ctx) => runtimeStore.tryGetRuntime()?.beforeRun(event, ctx));
    api.on(
      "before_tool_call",
      (event, ctx) =>
        runtimeStore.tryGetRuntime()?.beforeTool(event, ctx) ??
        (event.toolName === "continuity_advance"
          ? { block: true, blockReason: "service-not-running" }
          : undefined),
      {
        matcher: ["continuity_advance"],
        timeoutMs: 35_000,
      },
    );
    api.on("agent_end", (event, ctx) => runtimeStore.tryGetRuntime()?.agentEnd(event, ctx));
    if (api.registrationMode !== "full") {
      return;
    }
    const contexts = createContextHost(api, () => role, findActivity);
    const controller: Controller = {
      isRunning: () => running,
      execute: async (sessionKey, toolCallId, signal) => {
        requireValue(sessionKey, "exact-session-binding-required");
        const key = callKey(sessionKey, toolCallId);
        const binding = calls.get(key);
        calls.delete(key);
        requireValue(
          binding && !signal?.aborted && !binding.signal?.aborted,
          "live-tool-binding-required",
        );
        requireValue(runs.has(runKey(binding.sessionKey, binding.runId)), "run-not-live");
        const current = home().get(binding.activityId);
        const turn = current.turns.find(
          (candidate) =>
            candidate.runId === binding.runId && candidate.sessionKey === binding.sessionKey,
        );
        requireValue(turn, "turn-not-admitted");
        const completed = current.operations.filter(
          (record) =>
            record.state === "succeeded" &&
            record.operation.decisionRevision === turn.decisionRevision,
        ).length;
        const admitted = home().proposeOperation(binding.activityId, binding.runId, {
          direction: turn.direction,
          step: count(completed + 1),
        });
        return {
          content: [
            { type: "text", text: JSON.stringify({ outcome: "admitted", operation: admitted }) },
          ],
          details: { operation: admitted },
        };
      },
      beforePrompt: (_event, ctx) => {
        if (!ctx.sessionKey) {
          return undefined;
        }
        const activity = findActivity(ctx.sessionKey);
        if (!activity) {
          return undefined;
        }
        requireValue(ctx.runId, "exact-run-binding-required");
        requireValue(
          runs.size < 128 || runs.has(runKey(ctx.sessionKey, ctx.runId)),
          "run-binding-capacity",
        );
        const queued = scheduled.get(activity.id);
        if (ctx.jobId) {
          // An orphaned predecessor's Cron job cannot gain authority from a
          // replacement controller. Repeated prompt builds keep a live binding.
          requireValue(
            (queued?.handle?.id === ctx.jobId && !queued.cancelled) ||
              runs.get(runKey(ctx.sessionKey, ctx.runId))?.jobId === ctx.jobId,
            "scheduled-turn-binding-required",
          );
        }
        const turn = home().beginTurn(activity.id, ctx.sessionKey, ctx.runId);
        runs.set(runKey(ctx.sessionKey, ctx.runId), {
          activityId: activity.id,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
        });
        // Only the host's exact Cron job ID proves the queued turn has started.
        // Ordinary manual turns leave its cleanup ownership intact.
        if (queued?.handle && ctx.jobId === queued.handle.id) {
          queued.cleanupRequired = false;
          scheduled.delete(activity.id);
        }
        return {
          toolsAllow: ["continuity_advance"],
          prependContext: `Synthetic continuity activity ${activity.id}; admitted direction ${turn.direction}, revision ${turn.decisionRevision}. Use continuity_advance exactly once to propose the next eligible step.\n${contexts.promptContext(ctx.sessionKey)}`,
        };
      },
      beforeRun: (_event, ctx) => {
        if (!ctx.sessionKey || !enrolledSessions.has(ctx.sessionKey)) {
          return undefined;
        }
        try {
          requireRunning();
          requireValue(ctx.runId, "exact-run-binding-required");
          const binding = runs.get(runKey(ctx.sessionKey, ctx.runId));
          requireValue(binding, "prompt-admission-missing");
          requireValue(binding.jobId === ctx.jobId, "scheduled-turn-binding-required");
          home().beginTurn(binding.activityId, binding.sessionKey, binding.runId);
          contexts.promptContext(binding.sessionKey);
          return { outcome: "pass" };
        } catch (error) {
          return {
            outcome: "block",
            reason: failure(error),
            message: "The continuity activity needs a current authorized turn.",
          };
        }
      },
      beforeTool: async (event, ctx) => {
        if (event.toolName !== "continuity_advance") {
          return undefined;
        }
        try {
          requireValue(
            ctx.sessionKey && ctx.runId && ctx.toolCallId && !ctx.abortSignal?.aborted,
            "exact-live-tool-binding-required",
          );
          const key = callKey(ctx.sessionKey, ctx.toolCallId);
          const binding = runs.get(runKey(ctx.sessionKey, ctx.runId));
          requireValue(
            binding && calls.size < 128 && held.size < 128 && !held.has(key) && !calls.has(key),
            "run-not-live",
          );
          if (holds.has(binding.activityId)) {
            await new Promise<void>((resolve, reject) => {
              const finish = (error?: Error) => {
                clearTimeout(timer);
                ctx.abortSignal?.removeEventListener("abort", aborted);
                held.delete(key);
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              };
              const aborted = () => finish(new ContinuityError("held-call-aborted"));
              const timer = setTimeout(
                () => finish(new ContinuityError("held-call-timeout")),
                30_000,
              );
              held.set(key, { ...binding, release: () => finish(), cancel: aborted });
              ctx.abortSignal?.addEventListener("abort", aborted, { once: true });
              if (ctx.abortSignal?.aborted) {
                aborted();
              }
            });
          }
          requireValue(
            !ctx.abortSignal?.aborted && runs.has(runKey(binding.sessionKey, binding.runId)),
            "run-not-live",
          );
          home().beginTurn(binding.activityId, binding.sessionKey, binding.runId);
          calls.set(key, { ...binding, ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}) });
          return { params: {} };
        } catch (error) {
          return { block: true, blockReason: failure(error) };
        }
      },
      agentEnd: (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!ctx.sessionKey || !runId) {
          return;
        }
        const binding = runs.get(runKey(ctx.sessionKey, runId));
        if (binding) {
          try {
            home().finishTurn(binding.activityId, runId);
          } finally {
            clearRun(binding);
          }
        }
      },
    };

    const stop = (): Promise<void> => {
      if (stopping) {
        return stopping;
      }
      running = false;
      generation += 1;
      // Keep this inactive controller's bounded enrollment set as a tombstone:
      // discovery hooks can block owned sessions while unrelated sessions pass.
      // A new owner may replace it; stale cleanup never clears the shared slot.
      for (const job of scheduled.values()) {
        job.cancelled = true;
      }
      for (const gate of held.values()) {
        gate.cancel();
      }
      runs.clear();
      calls.clear();
      held.clear();
      holds.clear();
      contexts.stop();
      engine = undefined;
      destination = undefined;
      meta = undefined;
      const task = (async () => {
        // Preparation has no cancellation handle. Await it, then remove any job
        // it produced after stop. Native registry cleanup remains a second owner.
        await Promise.allSettled(pendingSchedules);
        const results = await Promise.allSettled([...scheduled.values()].map(cancelSchedule));
        for (const [id, job] of scheduled) {
          if (!job.cleanupRequired) {
            scheduled.delete(id);
          }
        }
        requireValue(
          results.every((result) => result.status === "fulfilled"),
          "scheduled-turn-cleanup-failed",
        );
      })();
      stopping = task;
      void task
        .finally(() => {
          if (stopping === task) {
            stopping = undefined;
          }
        })
        .catch(() => {});
      // The host owns the keyed store connection; never close the global database.
      return task;
    };
    api.registerService({
      id: "continuity-spike",
      start() {
        requireValue(
          !running && !stopping && !runtimeStore.tryGetRuntime()?.isRunning(),
          "service-owner-already-active",
        );
        requireValue(!retired, "plugin-retired");
        requireValue(scheduled.size === 0, "scheduled-turn-cleanup-required");
        try {
          meta = api.runtime.state.openSyncKeyedStore<{ role: Role }>({
            namespace: "meta",
            maxEntries: 1,
            overflowPolicy: "reject-new",
          });
          const saved = meta.lookup("role");
          requireValue(
            saved === undefined ||
              saved.role === "home" ||
              saved.role === "company" ||
              saved.role === "family",
            "invalid-stored-role",
          );
          role = saved?.role;
          openRole();
          if (role === "home") {
            engine?.recover();
          }
          contexts.start();
          generation += 1;
          running = true;
          runtimeStore.setRuntime(controller);
        } catch (error) {
          running = false;
          engine = undefined;
          destination = undefined;
          meta = undefined;
          role = undefined;
          contexts.stop();
          throw error;
        }
      },
      stop,
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: "continuity-spike",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (!sessionKey && !runId && (reason === "disable" || reason === "restart")) {
          retired = true;
          return stop();
        }
        for (const binding of runs.values()) {
          if (
            (!sessionKey || sessionKey === binding.sessionKey) &&
            (!runId || runId === binding.runId)
          ) {
            clearRun(binding);
          }
        }
        return undefined;
      },
    });
    const register = (
      suffix: string,
      scope: "operator.admin" | "operator.read",
      handler: (params: unknown) => unknown,
    ) => {
      api.registerGatewayMethod(
        `continuity_spike.${suffix}`,
        async ({ params, respond }: GatewayRequestHandlerOptions) => {
          try {
            requireRunning();
            respond(true, await handler(params ?? {}));
          } catch (error) {
            respond(false, undefined, continuityRpcError(error));
          }
        },
        { scope },
      );
    };
    register("init", "operator.admin", (value) => {
      const p = shape(value, ["role"], ["role"]);
      requireValue(
        p.role === "home" || p.role === "company" || p.role === "family",
        "invalid-role",
      );
      requireValue(meta, "service-not-running");
      const inserted = meta.registerIfAbsent("role", { role: p.role });
      const saved = meta.lookup("role");
      requireValue(saved?.role === p.role, "role-already-bound");
      if (!role) {
        role = saved.role;
        openRole();
      }
      return { role, initialized: true, created: inserted };
    });
    register("enroll", "operator.admin", (value) => {
      const p = shape(
        value,
        ["id", "sessionKey", "destinationId", "mode", "targetSteps"],
        ["id", "sessionKey", "destinationId", "mode"],
      );
      requireValue(p.mode === "next-turn" || p.mode === "operation", "invalid-consistency-mode");
      requireValue(!findActivity(text(p, "sessionKey", 256)), "session-already-enrolled");
      const state = home().enroll({
        id: text(p, "id"),
        sessionKey: text(p, "sessionKey", 256),
        destinationId: text(p, "destinationId"),
        mode: p.mode,
        targetSteps: count(p.targetSteps ?? 1),
      });
      enrolledSessions.add(state.sessionKey);
      return state;
    });
    register("destination.enroll", "operator.admin", (value) => {
      const p = shape(value, ["id", "targetSteps"], ["id"]);
      return remote().enroll({ id: text(p, "id"), targetSteps: count(p.targetSteps ?? 1) });
    });
    register("status", "operator.read", (value) => {
      const p = shape(value, ["id"]);
      const owner = role === "home" ? home() : remote();
      // Gate whole aggregates: artifacts and home operation records also carry receipt data.
      if (p.id === undefined) {
        return { role, activities: owner.list().filter((state) => state.policy.statusRead) };
      }
      const state = owner.get(text(p, "id"));
      requireValue(
        state.policy.statusRead,
        role === "home" ? "home-status-denied" : "destination-status-denied",
      );
      return state;
    });
    register("decision", "operator.admin", (value) => {
      const p = shape(value, ["id", "direction", "requestId"], ["id", "direction", "requestId"]);
      return home().acceptDecision(text(p, "id"), direction(p.direction), text(p, "requestId"));
    });
    register("attachment", "operator.admin", (value) => {
      const p = shape(value, ["id", "connected", "destinationRevision"], ["id", "connected"]);
      return home().setAttachment(text(p, "id"), {
        connected: flag(p, "connected"),
        ...(p.destinationRevision === undefined
          ? {}
          : { destinationRevision: revision(p.destinationRevision) }),
      });
    });
    register("policy", "operator.admin", (value) => {
      const p = shape(value, ["id", "execute", "statusRead", "cancel"], ["id"]);
      const patch: Partial<ActivityPolicy> = {};
      for (const key of ["execute", "statusRead", "cancel"] as const) {
        if (p[key] !== undefined) {
          patch[key] = flag(p, key);
        }
      }
      return role === "home"
        ? home().setPolicy(text(p, "id"), patch)
        : remote().setPolicy(text(p, "id"), patch);
    });
    register("dispatch", "operator.admin", (value) => {
      const p = shape(value, ["id", "operationId"], ["id", "operationId"]);
      return home().markDispatched(text(p, "id"), text(p, "operationId"));
    });
    register("unknown", "operator.admin", (value) => {
      const p = shape(value, ["id", "operationId"], ["id", "operationId"]);
      home().markUnknown(text(p, "id"), text(p, "operationId"));
      return { outcome: "outcome-unknown" };
    });
    register("receipt", "operator.admin", (value) => {
      const p = shape(value, ["id", "receipt"], ["id", "receipt"]);
      return home().settleReceipt(text(p, "id"), receipt(p.receipt));
    });
    register("execute", "operator.admin", (value) => {
      const p = shape(value, ["operation"], ["operation"]);
      return remote().execute(operation(p.operation));
    });
    register("lookup", "operator.read", (value) => {
      const p = shape(value, ["id", "operationId"], ["id", "operationId"]);
      return remote().status(text(p, "id"), text(p, "operationId"));
    });
    register("cancel", "operator.admin", (value) => {
      if (role === "home") {
        const p = shape(value, ["id", "operationId"], ["id", "operationId"]);
        return home().requestCancellation(text(p, "id"), text(p, "operationId"));
      }
      const p = shape(value, ["operation"], ["operation"]);
      return remote().cancel(operation(p.operation));
    });
    register("stop", "operator.admin", async (value) => {
      const p = shape(value, ["id"], ["id"]);
      const id = text(p, "id");
      const state = home().stop(id);
      for (const binding of runs.values()) {
        if (binding.activityId === id) {
          clearRun(binding);
        }
      }
      const job = scheduled.get(id);
      if (job) {
        job.cancelled = true;
        // The scheduling owner cancels late handles before its task settles.
        // Its expected cancellation/preparation error is harmless only after
        // confirmed cleanup; a missing handle alone does not establish that.
        await job.pending?.catch((error: unknown) => {
          if (job.cleanupRequired) {
            throw error;
          }
        });
        await cancelSchedule(job);
      }
      return state;
    });
    register("destination.change", "operator.admin", (value) => {
      const p = shape(value, ["id"], ["id"]);
      return remote().changeState(text(p, "id"));
    });
    register("schedule", "operator.admin", (value) => {
      const p = shape(value, ["id"], ["id"]);
      return schedule(text(p, "id"));
    });
    register("hold", "operator.admin", (value) => {
      const p = shape(value, ["id", "enabled"], ["id", "enabled"]);
      const id = text(p, "id");
      home().get(id);
      if (flag(p, "enabled")) {
        holds.add(id);
      } else {
        holds.delete(id);
        for (const gate of held.values()) {
          if (gate.activityId === id) {
            gate.release();
          }
        }
      }
      return { enabled: holds.has(id) };
    });
    register("held", "operator.read", (value) => {
      const p = shape(value, ["id"], ["id"]);
      const id = text(p, "id");
      const gate = Array.from(held.values()).find((candidate) => candidate.activityId === id);
      return gate ? { held: true, runId: gate.runId } : { held: false };
    });
  },
});
