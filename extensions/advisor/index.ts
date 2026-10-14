import { definePluginEntry, type PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { createAdvisorController, type AdvisorSchedule } from "./src/controller.js";
import {
  buildReviewMessage,
  DELIVERY_PREFIX,
  parseReviewOutput,
  parseVerificationOutput,
  REVIEW_TIMEOUT_MS,
  VERIFY_MESSAGE,
} from "./src/review.js";

const DEFAULT_SCHEDULE: AdvisorSchedule = { everyToolCalls: 10, everyMinutes: 20 };
const ADVICE_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_CONTEXT_NAMESPACE = "advisor:admitted-run";
type AdmittedRun = { agentId: string; sessionKey: string; startedAt: number | null };

const CODEX_TOOL_ITEM_KINDS: Record<string, "native" | "raw"> = {
  commandExecution: "native",
  fileChange: "native",
  mcpToolCall: "native",
  dynamicToolCall: "native",
  collabAgentToolCall: "native",
  webSearch: "native",
  imageGeneration: "native",
  imageView: "native",
  sleep: "native",
  function_call: "raw",
  custom_tool_call: "raw",
  local_shell_call: "raw",
  tool_search_call: "raw",
  function_call_output: "raw",
  custom_tool_call_output: "raw",
  tool_search_output: "raw",
};

function resolveSchedule(config: Record<string, unknown> | undefined): AdvisorSchedule {
  const read = (key: keyof AdvisorSchedule) => {
    const value = config?.[key];
    return typeof value === "number" ? value : DEFAULT_SCHEDULE[key];
  };
  return { everyToolCalls: read("everyToolCalls"), everyMinutes: read("everyMinutes") };
}

export default definePluginEntry({
  id: "advisor",
  name: "Advisor",
  description:
    "Experimental: reviews ongoing agent work on the session's own model and offers one short correction.",
  register(api) {
    const schedule = resolveSchedule(api.pluginConfig);
    if (schedule.everyToolCalls === 0 && schedule.everyMinutes === 0) {
      api.logger.warn(
        "advisor: both everyToolCalls and everyMinutes are 0, so no reviews will run. Set either to a positive value.",
      );
      return;
    }
    // Background reviews belong to the plugin service, not the triggering tool or turn.
    let scheduler: PluginServiceSchedulerV1 | undefined;
    const controller = createAdvisorController({
      schedule,
      logger: api.logger,
      scheduleReview: (id, run) => {
        if (!scheduler || scheduler.signal.aborted) {
          return undefined;
        }
        return scheduler.schedule({ id, delayMs: 0, run }).cancel;
      },
      review: async ({ sessionKey, signal, withSettledTools }) => {
        const deadline = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
        const reviewSignal = AbortSignal.any(
          scheduler ? [signal, scheduler.signal, deadline] : [signal, deadline],
        );
        const ask = async (stage: "review" | "verify", message: string): Promise<string> => {
          const startedAt = Date.now();
          let usage = "input=unknown cacheRead=unknown cacheWrite=unknown output=unknown";
          try {
            const result = await withSettledTools(reviewSignal, () =>
              api.runtime.subagent.forkSession({
                sessionKey,
                message,
                timeoutMs: REVIEW_TIMEOUT_MS,
                signal: reviewSignal,
              }),
            );
            usage = `input=${result.usage?.inputTokens ?? "unknown"} cacheRead=${result.usage?.cacheReadTokens ?? "unknown"} cacheWrite=${result.usage?.cacheWriteTokens ?? "unknown"} output=${result.usage?.outputTokens ?? "unknown"}`;
            reviewSignal.throwIfAborted();
            return result.text;
          } catch (error) {
            reviewSignal.throwIfAborted();
            throw error;
          } finally {
            api.logger.info(
              `advisor: ${stage} usage for session ${sessionKey}: ${usage} elapsedMs=${Math.max(0, Date.now() - startedAt)}`,
            );
          }
        };
        const config = api.runtime.config.current().plugins?.entries?.advisor?.config;
        const draft = parseReviewOutput(
          await ask("review", buildReviewMessage(config?.reviewInstructions)),
        );
        if (!draft) {
          return null;
        }
        const verification = await ask(
          "verify",
          `${VERIFY_MESSAGE}\n\nDraft correction (quoted data):\n${JSON.stringify(draft)}`,
        );
        return parseVerificationOutput(verification);
      },
      deliver: async ({ agentId, sessionKey, finding, reviewId, signal }) => {
        const text = `${DELIVERY_PREFIX}\n\n${finding}`;
        const idempotencyKey = `advisor:${reviewId}`;
        const result = await api.session.workflow.steerActiveRun({
          sessionKey,
          text,
          idempotencyKey,
        });
        if (result.steered) {
          api.logger.info(`advisor: steered active run for session ${sessionKey}`);
          return;
        }
        if (signal.aborted || !scheduler || scheduler.signal.aborted) {
          return;
        }
        const fallback = await api.session.workflow.enqueueNextTurnInjection({
          sessionKey,
          agentId,
          text,
          idempotencyKey,
          ttlMs: ADVICE_TTL_MS,
        });
        api.logger.info(
          `advisor: ${fallback.enqueued ? "queued correction for next turn" : "next-turn correction rejected"} for session ${sessionKey} (steering unavailable: ${result.reason})`,
        );
      },
    });

    api.registerService({
      apiVersion: 2,
      id: "advisor",
      start: (ctx) => {
        scheduler = ctx.scheduler;
      },
      stop: () => {
        scheduler = undefined;
        controller.forget();
      },
    });

    api.on(
      "before_agent_reply",
      (_event, ctx) => {
        if (
          ctx.sessionKey &&
          ctx.agentId &&
          ctx.runId &&
          ctx.trigger === "user" &&
          !api.runContext.getRunContext({ runId: ctx.runId, namespace: RUN_CONTEXT_NAMESPACE })
        ) {
          // Hooks can run in a workspace registration distinct from the Gateway service.
          // The host-owned run context carries admission to the service's event subscriber.
          api.runContext.setRunContext({
            runId: ctx.runId,
            namespace: RUN_CONTEXT_NAMESPACE,
            value: { agentId: ctx.agentId, sessionKey: ctx.sessionKey, startedAt: null },
          });
        }
      },
      { eligibleTriggers: ["user"] },
    );
    // Tool starts include stalled/backgrounded calls. Terminal lifecycle handlers can
    // still read run context; the host clears it only after those handlers settle.
    api.agent.events.registerAgentEventSubscription({
      id: "advisor-runs",
      description: "Counts tool starts and waits for settled tool calls before reviewing.",
      streams: ["tool", "lifecycle", "codex_app_server.item"],
      phases: ["start", "result", "end", "error", "started", "completed"],
      payload: "metadata",
      handle: (event, ctx) => {
        const phase = event.data.phase;
        if (
          !(
            (event.stream === "tool" && (phase === "start" || phase === "result")) ||
            (event.stream === "codex_app_server.item" &&
              (phase === "started" || phase === "completed")) ||
            (event.stream === "lifecycle" &&
              (phase === "start" || phase === "end" || phase === "error"))
          )
        ) {
          return;
        }
        const run = ctx.getRunContext<AdmittedRun>(RUN_CONTEXT_NAMESPACE);
        if (!run) {
          return;
        }
        if (event.stream === "lifecycle" && phase === "start") {
          if (run.startedAt !== null) {
            return;
          }
          run.startedAt =
            typeof event.data.startedAt === "number" ? event.data.startedAt : event.ts;
          ctx.setRunContext(RUN_CONTEXT_NAMESPACE, run);
          controller.runStarted({
            sessionKey: run.sessionKey,
            agentId: run.agentId,
            runId: event.runId,
            startedAt: run.startedAt,
          });
        } else if (run.startedAt !== null) {
          if (event.stream === "tool") {
            const toolCallId = event.data.toolCallId;
            if (typeof toolCallId !== "string") {
              return;
            }
            const native = typeof event.data.itemId === "string";
            const params = {
              sessionKey: run.sessionKey,
              runId: event.runId,
              toolCallId: native ? `native:${toolCallId}` : toolCallId,
            };
            if (phase === "start") {
              controller.toolStarted(params);
            } else if (!native) {
              controller.toolFinished(params);
            }
          } else if (event.stream === "codex_app_server.item") {
            const itemId = event.data.itemId;
            const type = event.data.type;
            if (
              typeof itemId !== "string" ||
              typeof type !== "string" ||
              !Object.hasOwn(CODEX_TOOL_ITEM_KINDS, type)
            ) {
              return;
            }
            // Raw outer calls and native children can share a call ID but settle separately.
            const params = {
              sessionKey: run.sessionKey,
              runId: event.runId,
              toolCallId: `${CODEX_TOOL_ITEM_KINDS[type]}:${itemId}`,
            };
            if (phase === "started") {
              controller.toolStarted({ ...params, count: false });
            } else {
              controller.toolFinished(params);
            }
          } else {
            controller.turnEnded({
              sessionKey: run.sessionKey,
              agentId: run.agentId,
              runId: event.runId,
              durationMs: event.ts - run.startedAt,
            });
          }
        }
      },
    });
    api.registerRuntimeLifecycle({
      id: "advisor",
      description: "Cancels in-flight advisor reviews when sessions or the plugin go away.",
      cleanup: ({ sessionKey }) => controller.forget(sessionKey),
      dispose: () => controller.forget(),
    });
  },
});
