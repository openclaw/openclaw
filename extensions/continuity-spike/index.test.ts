import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRuntimeMock,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type HookName = PluginHookRegistration["hookName"];
type GatewayMethod = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type ToolEntry = Parameters<OpenClawPluginApi["registerTool"]>[0];

/** Serialized public keyed-store contract; SQLite proof belongs to the Gateway demo. */
function createStateNamespaces() {
  const namespaces = new Map<string, Map<string, unknown>>();
  const open: OpenClawPluginApi["runtime"]["state"]["openSyncKeyedStore"] = <T>({
    namespace,
  }: {
    namespace: string;
  }): PluginStateSyncKeyedStore<T> => {
    let records = namespaces.get(namespace);
    if (!records) {
      records = new Map();
      namespaces.set(namespace, records);
    }
    const data = records;
    // The native generic JSON store likewise uses caller-declared record types.
    const lookup = (key: string): T | undefined => structuredClone(data.get(key)) as T | undefined;
    return {
      register(key, value) {
        data.set(key, structuredClone(value));
      },
      registerIfAbsent(key, value) {
        if (data.has(key)) {
          return false;
        }
        data.set(key, structuredClone(value));
        return true;
      },
      update(key, apply) {
        const value = apply(lookup(key));
        if (value === undefined) {
          return false;
        }
        data.set(key, structuredClone(value));
        return true;
      },
      lookup,
      consume(key) {
        const value = lookup(key);
        data.delete(key);
        return value;
      },
      delete(key) {
        return data.delete(key);
      },
      entries() {
        return [...data.keys()].map((key) => ({ key, value: lookup(key) as T, createdAt: 1 }));
      },
      clear() {
        data.clear();
      },
    };
  };
  return open;
}

const runningServices: Array<{
  service: OpenClawPluginService;
  context: OpenClawPluginServiceContext;
}> = [];

function registration(
  open: OpenClawPluginApi["runtime"]["state"]["openSyncKeyedStore"],
  mode: OpenClawPluginApi["registrationMode"] = "full",
) {
  const hooks = new Map<HookName, PluginHookRegistration["handler"]>();
  const methods = new Map<string, { handler: GatewayMethod; scope?: string }>();
  const services: OpenClawPluginService[] = [];
  const cleanups: PluginRuntimeLifecycleRegistration[] = [];
  const toolEntries: ToolEntry[] = [];
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = open;
  const api = createTestPluginApi({
    id: plugin.id,
    name: plugin.name,
    registrationMode: mode,
    runtime,
  });
  api.on = (name, handler) => {
    hooks.set(name, handler);
  };
  api.registerGatewayMethod = (name, handler, options) => {
    methods.set(name, { handler, scope: options?.scope });
  };
  api.registerService = (service) => {
    services.push(service);
  };
  api.registerTool = (entry) => {
    toolEntries.push(entry);
  };
  api.lifecycle.registerRuntimeLifecycle = (entry) => {
    cleanups.push(entry);
  };
  const scheduleTurn = vi
    .fn<OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"]>()
    .mockResolvedValue({
      id: "synthetic-job",
      pluginId: plugin.id,
      sessionKey: "synthetic-session",
      kind: "session-turn",
    });
  const unscheduleTurns = vi
    .fn<OpenClawPluginApi["session"]["workflow"]["unscheduleSessionTurnsByTag"]>()
    .mockResolvedValue({ removed: 1, failed: 0 });
  api.session.workflow.scheduleSessionTurn = scheduleTurn;
  api.session.workflow.unscheduleSessionTurnsByTag = unscheduleTurns;
  plugin.register(api);
  const serviceContext: OpenClawPluginServiceContext = {
    config: {},
    stateDir: "/unused-continuity-composition",
    logger: api.logger,
  };
  return {
    scheduleTurn,
    unscheduleTurns,
    async start() {
      const service = services.find((entry) => entry.id === plugin.id);
      if (!service) {
        throw new Error("Service registrar missing");
      }
      await service.start(serviceContext);
      runningServices.push({ service, context: serviceContext });
    },
    async stop() {
      const service = services.find((entry) => entry.id === plugin.id);
      if (!service) {
        throw new Error("Service registrar missing");
      }
      await service.stop?.(serviceContext);
    },
    async cleanup() {
      const lifecycle = cleanups.find((entry) => entry.id === plugin.id);
      if (!lifecycle?.cleanup) {
        throw new Error("Lifecycle registrar missing");
      }
      await lifecycle.cleanup({ reason: "disable" });
    },
    hook<K extends HookName>(name: K): PluginHookRegistration<K>["handler"] {
      const handler = hooks.get(name);
      if (!handler) {
        throw new Error(`Missing hook ${name}`);
      }
      // The registrar captures the generic name/handler pair; Map erases the correlation.
      return handler as PluginHookRegistration<K>["handler"];
    },
    async rpc(
      name: string,
      params: Record<string, unknown>,
      expectFailure = false,
    ): Promise<unknown> {
      const method = `continuity_spike.${name}`;
      const registered = methods.get(method);
      if (!registered) {
        throw new Error(`Missing method ${method}`);
      }
      expect(registered.scope).toBe(
        name === "status" || name === "lookup" ? "operator.read" : "operator.admin",
      );
      const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
      await registered.handler({
        req: { type: "req", id: "synthetic-rpc", method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond,
        get context(): never {
          throw new Error("Unrelated Gateway services are unavailable in this registration test");
        },
      });
      const response = respond.mock.calls.at(-1);
      if (!response) {
        throw new Error("RPC did not respond");
      }
      const [ok, result, error] = response;
      if (expectFailure) {
        if (ok) {
          throw new Error("RPC unexpectedly succeeded");
        }
        return error;
      }
      if (!ok) {
        throw new Error(error?.message ?? "RPC rejected");
      }
      return result;
    },
    async tool(sessionKey: string): Promise<AnyAgentTool> {
      const entry = toolEntries[0];
      if (!entry) {
        throw new Error("Tool registrar missing");
      }
      const resolved = typeof entry === "function" ? entry({ sessionKey }) : entry;
      const tool = Array.isArray(resolved)
        ? resolved.find((candidate) => candidate.name === "continuity_advance")
        : resolved;
      if (!tool || tool.name !== "continuity_advance") {
        throw new Error("Continuity tool missing");
      }
      return tool;
    },
  };
}

const sessionKey = "agent:main:continuity-company";
const activityId = "campaign-x";
const runId = "synthetic-run";
const toolCallId = "synthetic-tool-call";

async function enroll(root: ReturnType<typeof registration>) {
  await root.start();
  await root.rpc("init", { role: "home" });
  await root.rpc("enroll", {
    id: activityId,
    sessionKey,
    destinationId: "company",
    mode: "next-turn",
    targetSteps: 1,
  });
}

async function bind(scoped: ReturnType<typeof registration>) {
  const ctx = { sessionKey, runId };
  const prompt = await scoped.hook("before_prompt_build")(
    { prompt: "Advance the synthetic activity", messages: [] },
    ctx,
  );
  expect(prompt).toMatchObject({ toolsAllow: ["continuity_advance"] });
  expect(
    await scoped.hook("before_agent_run")(
      { prompt: "Advance the synthetic activity", messages: [] },
      ctx,
    ),
  ).toMatchObject({ outcome: "pass" });
  const signal = new AbortController().signal;
  expect(
    await scoped.hook("before_tool_call")(
      { toolName: "continuity_advance", params: {} },
      { ...ctx, toolName: "continuity_advance", toolCallId, abortSignal: signal },
    ),
  ).toMatchObject({ params: {} });
  return signal;
}

afterEach(async () => {
  for (const { service, context } of runningServices.splice(0).toReversed()) {
    await service.stop?.(context);
  }
});

describe("continuity registration composition", { concurrent: false }, () => {
  it.each(["full", "discovery"] as const)(
    "shares service-owned live bindings with an independent %s hook registry and discovery tools",
    async (mode) => {
      const open = createStateNamespaces();
      const root = registration(open);
      await enroll(root);
      const scoped = registration(open, mode);
      const discovery = registration(open, "discovery");
      const tool = await discovery.tool(sessionKey);
      await expect(tool.execute("unbound-call", {})).rejects.toThrow();
      const signal = await bind(scoped);
      const result = await tool.execute(toolCallId, {}, signal);
      expect(result.details).toMatchObject({
        operation: {
          activityId,
          destinationId: "company",
          runId,
          direction: "A",
          decisionRevision: 1,
        },
      });
      expect(await root.rpc("status", { id: activityId })).toMatchObject({
        operations: [{ state: "admitted", operation: { runId, direction: "A" } }],
      });
      await expect(tool.execute(toolCallId, {}, signal)).rejects.toThrow();
    },
  );

  it("revokes an already-bound discovery tool when the owning root service stops", async () => {
    const open = createStateNamespaces();
    const root = registration(open);
    await enroll(root);
    const scoped = registration(open, "discovery");
    const discovery = registration(open, "discovery");
    const signal = await bind(scoped);
    const tool = await discovery.tool(sessionKey);
    await root.stop();
    await expect(tool.execute(toolCallId, {}, signal)).rejects.toThrow();
    expect(
      await scoped.hook("before_agent_run")(
        { prompt: "Try to resume", messages: [] },
        { sessionKey, runId },
      ),
    ).toMatchObject({ outcome: "block", reason: "service-not-running" });
  });

  it("does not let stale owner cleanup clear a later service owner's bindings", async () => {
    const open = createStateNamespaces();
    const previous = registration(open);
    await enroll(previous);
    await previous.stop();
    const current = registration(open);
    await current.start();
    const scoped = registration(open, "discovery");
    const discovery = registration(open, "discovery");
    const signal = await bind(scoped);
    await previous.cleanup();
    const tool = await discovery.tool(sessionKey);
    const result = await tool.execute(toolCallId, {}, signal);
    expect(result.details).toMatchObject({ operation: { activityId, runId, direction: "A" } });
    expect(await current.rpc("status", { id: activityId })).toMatchObject({
      operations: [{ state: "admitted" }],
    });
  });

  it.each(["full", "discovery"] as const)(
    "lets unrelated hooks pass without a live %s runtime",
    async (mode) => {
      const root = registration(createStateNamespaces(), mode);
      const ctx = { sessionKey: "agent:main:unrelated", runId: "unrelated-run" };
      expect(
        await root.hook("before_prompt_build")({ prompt: "hello", messages: [] }, ctx),
      ).toBeUndefined();
      expect(
        await root.hook("before_agent_run")({ prompt: "hello", messages: [] }, ctx),
      ).toBeUndefined();
      expect(
        await root.hook("before_tool_call")(
          { toolName: "unrelated_tool", params: {} },
          { ...ctx, toolName: "unrelated_tool" },
        ),
      ).toBeUndefined();
      expect(
        await root.hook("before_tool_call")(
          { toolName: "continuity_advance", params: {} },
          { ...ctx, toolName: "continuity_advance" },
        ),
      ).toMatchObject({ block: true });
    },
  );

  it("enforces no-argument discovery metadata and still scrubs injected parameters", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    const tool = await root.tool(sessionKey);
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    await root.hook("before_prompt_build")(
      { prompt: "advance", messages: [] },
      { sessionKey, runId },
    );
    expect(
      await root.hook("before_tool_call")(
        { toolName: "continuity_advance", params: { direction: "B", destinationId: "family" } },
        { sessionKey, runId, toolCallId, toolName: "continuity_advance" },
      ),
    ).toEqual({ params: {} });
  });

  it("rolls back a failed service start so the same registration can retry", async () => {
    const open = createStateNamespaces();
    open<{ role: string }>({ namespace: "meta", maxEntries: 1 }).register("role", { role: "home" });
    let failOpen = true;
    const faulted: typeof open = <T>(params: Parameters<typeof open>[0]) => {
      if (params.namespace === "home" && failOpen) {
        failOpen = false;
        throw new Error("synthetic startup failure");
      }
      return open<T>(params);
    };
    const root = registration(faulted);
    await expect(root.start()).rejects.toThrow("synthetic startup failure");
    await root.start();
    expect(await root.rpc("status", {})).toMatchObject({ role: "home", activities: [] });
  });

  it("reopens retained scoped context after ordinary stop and start", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    await root.rpc("context.policy", {
      policy: {
        id: "policy-x",
        sourceId: "home",
        activityId,
        readers: ["home"],
        exportTo: [],
        retain: true,
      },
    });
    await root.stop();
    await expect(root.rpc("context.policy", { policy: {} })).rejects.toThrow();
    await root.start();
    expect(
      await root.rpc("context.policy", {
        policy: {
          id: "policy-x",
          sourceId: "home",
          activityId,
          readers: ["home"],
          exportTo: [],
          retain: true,
        },
      }),
    ).toEqual({ policyId: "policy-x" });
    await bind(root);
  });

  it("rejects binding saturation before admitting a durable turn", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    for (let index = 1; index < 3; index += 1) {
      await root.rpc("enroll", {
        id: `campaign-${index}`,
        sessionKey: `${sessionKey}-${index}`,
        destinationId: "company",
        mode: "next-turn",
      });
    }
    for (let index = 0; index < 128; index += 1) {
      const session = index % 3 === 0 ? sessionKey : `${sessionKey}-${index % 3}`;
      await root.hook("before_prompt_build")(
        { prompt: "advance", messages: [] },
        { sessionKey: session, runId: `capacity-run-${index}` },
      );
    }
    const before = await root.rpc("status", {});
    expect(() =>
      root.hook("before_prompt_build")(
        { prompt: "advance", messages: [] },
        { sessionKey, runId: "capacity-rejected-run" },
      ),
    ).toThrow("run-binding-capacity");
    expect(await root.rpc("status", {})).toEqual(before);
  });

  it("cancels a schedule that resolves after stop without touching a later owner's job", async () => {
    const open = createStateNamespaces();
    const previous = registration(open);
    await enroll(previous);
    const deferred = createDeferred<Awaited<ReturnType<typeof previous.scheduleTurn>>>();
    previous.scheduleTurn.mockReturnValueOnce(deferred.promise);
    const scheduled = previous.rpc("schedule", { id: activityId }, true);
    const stopping = previous.stop();
    const current = registration(open);
    await current.start();
    await current.rpc("schedule", { id: activityId });
    deferred.resolve({ id: "late-old-job", pluginId: plugin.id, sessionKey, kind: "session-turn" });
    expect(await scheduled).toMatchObject({ code: "UNAVAILABLE", message: "service-not-running" });
    await stopping;
    const previousTag = previous.scheduleTurn.mock.calls[0]?.[0].tag;
    const currentTag = current.scheduleTurn.mock.calls[0]?.[0].tag;
    expect(previousTag).toBeTruthy();
    expect(previousTag).not.toBe(currentTag);
    expect(previous.unscheduleTurns).toHaveBeenCalledWith({ sessionKey, tag: previousTag });
    expect(current.unscheduleTurns).not.toHaveBeenCalled();
    await previous.cleanup();
    await bind(current);
  });

  it("removes an already-created schedule when its activity stops", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    await root.rpc("schedule", { id: activityId });
    const tag = root.scheduleTurn.mock.calls[0]?.[0].tag;
    await root.rpc("stop", { id: activityId });
    expect(root.unscheduleTurns).toHaveBeenCalledWith({ sessionKey, tag });
    expect(await root.rpc("schedule", { id: activityId }, true)).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
      details: { category: "conflict" },
    });
  });

  it.each(["handle", "no-handle"] as const)(
    "does not acknowledge activity stop until pending creation and cleanup finish (%s)",
    async (result) => {
      const root = registration(createStateNamespaces());
      await enroll(root);
      const creation = createDeferred<Awaited<ReturnType<typeof root.scheduleTurn>>>();
      const cancellation = createDeferred<{ removed: number; failed: number }>();
      root.scheduleTurn.mockReturnValueOnce(creation.promise);
      root.unscheduleTurns.mockReturnValueOnce(cancellation.promise);
      const scheduled = root.rpc("schedule", { id: activityId }, true);
      const acknowledged = vi.fn();
      const stopping = root.rpc("stop", { id: activityId }).then(acknowledged);
      const handle =
        result === "handle"
          ? {
              id: "late-job",
              pluginId: plugin.id,
              sessionKey,
              kind: "session-turn" as const,
            }
          : undefined;
      try {
        // Cross a task boundary: an early RPC success must already be observable.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(acknowledged).not.toHaveBeenCalled();
        expect(await root.rpc("status", { id: activityId })).toMatchObject({ stopped: true });
        creation.resolve(handle);
        await vi.waitFor(() =>
          expect(root.unscheduleTurns).toHaveBeenCalledExactlyOnceWith({
            sessionKey,
            tag: root.scheduleTurn.mock.calls[0]?.[0].tag,
          }),
        );
        expect(acknowledged).not.toHaveBeenCalled();
        cancellation.resolve({ removed: 1, failed: 0 });
        await stopping;
        expect(acknowledged).toHaveBeenCalledOnce();
        expect(await scheduled).toMatchObject({
          code: "UNAVAILABLE",
          message: "service-not-running",
        });
      } finally {
        creation.resolve(handle);
        cancellation.resolve({ removed: 1, failed: 0 });
        await Promise.allSettled([scheduled, stopping]);
      }
    },
  );

  it.each(["undefined", "rejection"] as const)(
    "removes a created tagged job even when scheduling reports %s without a handle",
    async (outcome) => {
      const root = registration(createStateNamespaces());
      await enroll(root);
      const jobs = new Set<string>();
      root.scheduleTurn.mockImplementationOnce(async ({ tag }) => {
        if (!tag) {
          throw new Error("Expected an owned schedule tag");
        }
        jobs.add(tag);
        if (outcome === "rejection") {
          throw new Error("Uncertain failure after creation");
        }
        return undefined;
      });
      root.unscheduleTurns.mockImplementationOnce(async ({ tag }) => ({
        removed: jobs.delete(tag) ? 1 : 0,
        failed: 0,
      }));
      expect(await root.rpc("schedule", { id: activityId }, true)).toMatchObject({
        code: "UNAVAILABLE",
      });
      expect(root.unscheduleTurns).toHaveBeenCalledExactlyOnceWith({
        sessionKey,
        tag: root.scheduleTurn.mock.calls[0]?.[0].tag,
      });
      expect(jobs.size).toBe(0);
      await root.stop();
      expect(root.unscheduleTurns).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { removed: 0, failed: 0 },
    { removed: 0, failed: 1 },
  ])("retains uncertain creation when tag cleanup has no positive removal: %j", async (result) => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    root.scheduleTurn.mockResolvedValueOnce(undefined);
    root.unscheduleTurns.mockResolvedValue(result);
    try {
      expect(await root.rpc("schedule", { id: activityId }, true)).toMatchObject({
        code: "UNAVAILABLE",
        message: "scheduled-turn-cleanup-failed",
      });
      expect(await root.rpc("schedule", { id: activityId }, true)).toMatchObject({
        message: "scheduled-turn-cleanup-required",
      });
      expect(root.scheduleTurn).toHaveBeenCalledOnce();
      expect(await root.rpc("stop", { id: activityId }, true)).toMatchObject({
        message: "scheduled-turn-cleanup-failed",
      });
      await expect(root.stop()).rejects.toThrow("scheduled-turn-cleanup-failed");
      await expect(root.start()).rejects.toThrow("scheduled-turn-cleanup-required");
    } finally {
      root.unscheduleTurns.mockResolvedValue({ removed: 1, failed: 0 });
      await root.stop();
    }
    await root.start();
    expect(root.unscheduleTurns).toHaveBeenCalledTimes(4);
  });

  it("reports late-job cancellation failure to activity stop and retains cleanup for retry", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    const creation = createDeferred<Awaited<ReturnType<typeof root.scheduleTurn>>>();
    root.scheduleTurn.mockReturnValueOnce(creation.promise);
    root.unscheduleTurns.mockResolvedValueOnce({ removed: 0, failed: 1 });
    const scheduled = root.rpc("schedule", { id: activityId }, true);
    const stopping = root.rpc("stop", { id: activityId }, true);
    creation.resolve({ id: "late-job", pluginId: plugin.id, sessionKey, kind: "session-turn" });
    const results = await Promise.all([scheduled, stopping]);
    for (const result of results) {
      expect(result).toMatchObject({
        code: "UNAVAILABLE",
        message: "scheduled-turn-cleanup-failed",
      });
    }
    expect(root.unscheduleTurns).toHaveBeenCalledOnce();
    await root.rpc("stop", { id: activityId });
    expect(root.unscheduleTurns).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "unrelated-job"])(
    "retains the queued cleanup handle when a turn has job ID %s",
    async (jobId) => {
      const root = registration(createStateNamespaces());
      await enroll(root);
      await root.rpc("schedule", { id: activityId });
      const tag = root.scheduleTurn.mock.calls[0]?.[0].tag;
      const prompt = () =>
        root.hook("before_prompt_build")(
          { prompt: "advance", messages: [] },
          { sessionKey, runId: "manual-run", ...(jobId ? { jobId } : {}) },
        );
      if (jobId) {
        expect(prompt).toThrow("scheduled-turn-binding-required");
        expect(await root.rpc("status", { id: activityId })).toMatchObject({ turns: [] });
        expect(
          await root.hook("before_agent_run")(
            { prompt: "advance", messages: [] },
            { sessionKey, runId: "manual-run", jobId },
          ),
        ).toMatchObject({ outcome: "block" });
      } else {
        await prompt();
        // A failed prompt hook must not borrow an existing manual run binding.
        expect(
          await root.hook("before_agent_run")(
            { prompt: "advance", messages: [] },
            { sessionKey, runId: "manual-run", jobId: "orphan-job" },
          ),
        ).toMatchObject({ outcome: "block", reason: "scheduled-turn-binding-required" });
      }
      expect(root.unscheduleTurns).not.toHaveBeenCalled();
      await root.stop();
      expect(root.unscheduleTurns).toHaveBeenCalledExactlyOnceWith({ sessionKey, tag });
      await root.start();
      await root.rpc("schedule", { id: activityId });
      expect(root.scheduleTurn).toHaveBeenCalledTimes(2);
      expect(root.scheduleTurn.mock.calls[1]?.[0].tag).not.toBe(tag);
    },
  );

  it("does not admit an orphaned Cron job under a replacement controller", async () => {
    const open = createStateNamespaces();
    const previous = registration(open);
    await enroll(previous);
    previous.scheduleTurn.mockResolvedValueOnce(undefined);
    previous.unscheduleTurns.mockResolvedValue({ removed: 0, failed: 0 });
    try {
      await previous.rpc("schedule", { id: activityId }, true);
      await expect(previous.stop()).rejects.toThrow("scheduled-turn-cleanup-failed");
      const current = registration(open);
      await current.start();
      const ctx = { sessionKey, runId: "orphan-run", jobId: "orphan-job" };
      expect(() =>
        current.hook("before_prompt_build")({ prompt: "advance", messages: [] }, ctx),
      ).toThrow("scheduled-turn-binding-required");
      expect(
        await current.hook("before_agent_run")({ prompt: "advance", messages: [] }, ctx),
      ).toMatchObject({ outcome: "block" });
      expect(await current.rpc("status", { id: activityId })).toMatchObject({ turns: [] });
    } finally {
      previous.unscheduleTurns.mockResolvedValue({ removed: 1, failed: 0 });
      await previous.stop();
    }
  });

  it("releases a consumed schedule only for the exact native job ID", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    await root.rpc("schedule", { id: activityId });
    await root.hook("before_prompt_build")(
      { prompt: "advance", messages: [] },
      { sessionKey, runId: "scheduled-run", jobId: "synthetic-job" },
    );
    expect(
      await root.hook("before_prompt_build")(
        { prompt: "advance again", messages: [] },
        { sessionKey, runId: "scheduled-run", jobId: "synthetic-job" },
      ),
    ).toMatchObject({ toolsAllow: ["continuity_advance"] });
    expect(
      await root.hook("before_agent_run")(
        { prompt: "advance", messages: [] },
        { sessionKey, runId: "scheduled-run", jobId: "synthetic-job" },
      ),
    ).toMatchObject({ outcome: "pass" });
    await root.rpc("schedule", { id: activityId });
    expect(root.scheduleTurn).toHaveBeenCalledTimes(2);
    expect(root.unscheduleTurns).not.toHaveBeenCalled();
  });

  it("coalesces cancellation when activity stop overlaps service stop", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    await root.rpc("schedule", { id: activityId });
    const cancellation = createDeferred<{ removed: number; failed: number }>();
    root.unscheduleTurns.mockReturnValueOnce(cancellation.promise);
    const activityStop = root.rpc("stop", { id: activityId });
    const serviceStop = root.stop();
    // Allow service cleanup to reach the pending cancellation before resolving it.
    await Promise.resolve();
    await Promise.resolve();
    expect(root.unscheduleTurns).toHaveBeenCalledTimes(1);
    cancellation.resolve({ removed: 1, failed: 0 });
    await Promise.all([activityStop, serviceStop]);
    expect(root.unscheduleTurns).toHaveBeenCalledTimes(1);
  });

  it("reports scheduler cleanup failure instead of silently discarding its handle", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    await root.rpc("schedule", { id: activityId });
    root.unscheduleTurns.mockResolvedValueOnce({ removed: 0, failed: 1 });
    await expect(root.stop()).rejects.toThrow("scheduled-turn-cleanup-failed");
    await root.stop();
    expect(root.unscheduleTurns).toHaveBeenCalledTimes(2);
  });

  it("exposes input, permission, and conflict failures through the registered RPC boundary", async () => {
    const root = registration(createStateNamespaces());
    await enroll(root);
    expect(
      await root.rpc("decision", { id: activityId, direction: "C", requestId: "request-1" }, true),
    ).toMatchObject({ code: "INVALID_REQUEST", retryable: false, details: { category: "input" } });
    await root.rpc("decision", { id: activityId, direction: "B", requestId: "request-1" });
    expect(
      await root.rpc("decision", { id: activityId, direction: "A", requestId: "request-1" }, true),
    ).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
      details: { category: "conflict" },
    });
    await root.stop();
    const destination = registration(createStateNamespaces());
    await destination.start();
    await destination.rpc("init", { role: "company" });
    await destination.rpc("destination.enroll", { id: activityId });
    await destination.rpc("policy", { id: activityId, statusRead: false });
    expect(
      await destination.rpc("lookup", { id: activityId, operationId: "unknown-operation" }, true),
    ).toMatchObject({ code: "FORBIDDEN", retryable: false, details: { category: "denied" } });
  });

  it.each(
    (["home", "company", "family"] as const).flatMap((role) =>
      (["id", "list"] as const).map((form) => ({ role, form })),
    ),
  )("applies current $role status-read policy to the $form response", async ({ role, form }) => {
    const root = registration(createStateNamespaces());
    await root.start();
    await root.rpc("init", { role });
    for (const id of [activityId, "visible-control"]) {
      await root.rpc(
        role === "home" ? "enroll" : "destination.enroll",
        role === "home"
          ? { id, sessionKey: `agent:main:${id}`, destinationId: "company", mode: "next-turn" }
          : { id },
      );
    }
    const original = await root.rpc("status", { id: activityId });
    const control = await root.rpc("status", { id: "visible-control" });
    expect(await root.rpc("status", {})).toEqual({ role, activities: [original, control] });

    await root.rpc("policy", { id: activityId, statusRead: false });
    const assertRevoked = async () => {
      if (form === "id") {
        expect(await root.rpc("status", { id: activityId }, true)).toMatchObject({
          code: "FORBIDDEN",
          retryable: false,
          details: {
            category: "denied",
            reason: role === "home" ? "home-status-denied" : "destination-status-denied",
          },
        });
      } else {
        expect(await root.rpc("status", {})).toEqual({ role, activities: [control] });
      }
      expect(await root.rpc("status", { id: "visible-control" })).toEqual(control);
    };
    await assertRevoked();
    await root.stop();
    await root.start();
    await assertRevoked();

    const restored = await root.rpc("policy", { id: activityId, statusRead: true });
    expect(await root.rpc("status", { id: activityId })).toEqual(restored);
    expect(await root.rpc("status", {})).toEqual({ role, activities: [restored, control] });
  });
});
