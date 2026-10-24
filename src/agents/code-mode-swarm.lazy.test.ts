import { expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PendingBridgeRequest } from "./code-mode-worker-types.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";
type Registry = typeof import("./subagents/registry/subagent-registry.js");
type Publication = typeof import("./subagents/registry/subagent-registry-publication.js");

it("fences swarm effects after owner or policy loss during a shared runtime import", async () => {
  vi.resetModules();
  const entered = createDeferred();
  const release = createDeferred();
  const bridgeCalls: Promise<void>[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const lookup = vi.fn<Registry["getSwarmRunByLaunchReplayKey"]>();
  const initialize = vi.fn();
  const prepareCollectors = vi.fn<Registry["prepareSubagentRunsByRunIds"]>();
  const wait = vi.fn<typeof import("./tools/agents-wait-tool.js").waitForCollectorCompletion>();
  const subscribe = vi.fn<Publication["subscribeSubagentRunChanges"]>();
  const emit =
    vi.fn<typeof import("../sessions/session-lifecycle-events.js").emitSessionLifecycleEvent>();
  const load = vi.fn(
    async (importOriginal: () => Promise<typeof import("./code-mode-swarm.runtime.js")>) => {
      const actual = await importOriginal();
      entered.resolve();
      await release.promise;
      return actual;
    },
  );
  vi.doMock("./code-mode-swarm.runtime.js", load);
  vi.doMock("./subagents/registry/subagent-registry.js", () => ({
    getSwarmRunByLaunchReplayKey: lookup,
    initSubagentRegistry: initialize,
    prepareSubagentRunsByRunIds: prepareCollectors,
  }));
  vi.doMock("./tools/agents-wait-tool.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./tools/agents-wait-tool.js")>();
    wait.mockImplementation(actual.waitForCollectorCompletion);
    return { ...actual, waitForCollectorCompletion: wait };
  });
  vi.doMock("./subagents/registry/subagent-registry-publication.js", async (importOriginal) => {
    const actual = await importOriginal<Publication>();
    subscribe.mockImplementation(actual.subscribeSubagentRunChanges);
    return {
      ...actual,
      subscribeSubagentRunChanges: ((phase, listener) =>
        phase === "projection"
          ? actual.subscribeSubagentRunChanges(phase, listener)
          : subscribe(phase, listener)) satisfies typeof actual.subscribeSubagentRunChanges,
    };
  });
  vi.doMock("../sessions/session-lifecycle-events.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../sessions/session-lifecycle-events.js")>();
    emit.mockImplementation(actual.emitSessionLifecycleEvent);
    return { ...actual, emitSessionLifecycleEvent: emit };
  });
  try {
    const { applyCodeModeCatalog, createCodeModeTools, resolveCodeModeConfig } =
      await import("./code-mode.js");
    const { clearToolSearchCatalog, createToolSearchCatalogRef } =
      await import("./tool-search-catalog.js");
    const { ToolSearchRuntime } = await import("./tool-search-runtime.js");
    const { toToolSearchConfig } = await import("./code-mode-runtime.js");
    const { createCodeModeCatalogProjection } = await import("./code-mode-catalog.js");
    const { createCodeModeNamespaceRuntime } = await import("./code-mode-namespaces.js");
    const bridge = await import("./code-mode-bridge.js");
    const originalBridge = bridge.runBridgeRequest;
    vi.spyOn(bridge, "runBridgeRequest").mockImplementation((params) => {
      const call = originalBridge(params);
      bridgeCalls.push(call);
      return call;
    });
    const { createCodeModeRunOwner, createPendingBridgeStates, waitForPendingBridgeSettlement } =
      await import("./code-mode-state.js");
    const spawn = vi.fn(async () => ({
      content: [],
      details: { status: "accepted", runId: "collector" },
    }));
    const requests: PendingBridgeRequest[] = [
      { id: "spawn", method: "agentSpawn", args: ["Research"] },
      { id: "wait", method: "agentWait", args: ["collector"] },
      { id: "note", method: "swarmNote", args: [{ kind: "phase", text: "Plan" }] },
    ];
    function createRun() {
      const config = { tools: { codeMode: true, swarm: { enabled: true } } };
      const ctx: ToolSearchToolContext = {
        config,
        runtimeConfig: config,
        catalogRef: createToolSearchCatalogRef(),
        sessionKey: "agent:main:main",
        sessionId: "session-swarm",
        runId: "run-swarm",
      };
      const spawnTool: AnyAgentTool = {
        name: "sessions_spawn",
        label: "Spawn",
        description: "Spawn a collector",
        parameters: { type: "object", properties: {} },
        execute: spawn,
      };
      applyCodeModeCatalog({ ...ctx, tools: [...createCodeModeTools(ctx), spawnTool] });
      const limits = resolveCodeModeConfig(config);
      const owner = createCodeModeRunOwner(ctx, limits);
      cleanups.push(async () => {
        await owner.close();
        clearToolSearchCatalog(ctx);
      });
      const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(limits));
      return {
        ctx,
        config,
        owner,
        dispatch: (pendingRequests = requests) =>
          createPendingBridgeStates(pendingRequests, {
            inbox: owner.inbox,
            results: owner.results,
            runtime,
            ctx,
            catalogProjection: createCodeModeCatalogProjection(runtime.all({ includeMcp: false })),
            namespaceRuntime: createCodeModeNamespaceRuntime(runtime.namespaceEntries()),
            parentToolCallId: "swarm-call",
            codeModeRunId: "replay",
            remainingMs: 10_000,
            signal: owner.signal,
            bridgeDispatch: { started: false },
          }),
      };
    }
    function deny(run: ReturnType<typeof createRun>, gate: string) {
      if (gate === "disabled") {
        run.config.tools.swarm.enabled = false;
      } else {
        run.ctx.toolExecutionAllow = ["skill_workshop"];
      }
    }
    async function expectUnavailable(
      pending: ReturnType<ReturnType<typeof createRun>["dispatch"]>,
    ) {
      for (const entry of pending) {
        await waitForPendingBridgeSettlement([entry], { kind: "awaiting" });
        expect(() => entry.reply.take()).toThrow("unavailable");
      }
    }

    // Cheap refusals must not start the shared load at all.
    for (const gate of ["disabled", "allowlist"] as const) {
      const run = createRun();
      deny(run, gate);
      const pending = run.dispatch();
      await waitForPendingBridgeSettlement(pending, {
        kind: "draining",
        requiredRequestIds: pending.map((entry) => entry.id),
      });
      expect(pending.every((entry) => !entry.reply.take().ok)).toBe(true);
      expect(load).not.toHaveBeenCalled();
    }

    const closedRuns = ["owner", "catalog", "disabled", "allowlist"].map((kind) => {
      const run = createRun();
      return { kind, run, pending: run.dispatch() };
    });
    const survivor = createRun();
    const live = survivor.dispatch([
      { id: "live-note", method: "swarmNote", args: [{ kind: "log", text: "Still live" }] },
    ]);
    await entered.promise;
    for (const { kind, run, pending } of closedRuns) {
      if (kind === "owner") {
        await run.owner.close(new Error("owner closed"));
      } else if (kind === "catalog") {
        clearToolSearchCatalog(run.ctx);
      } else {
        deny(run, kind);
      }
      if (kind === "owner" || kind === "catalog") {
        expect(run.owner.signal.aborted).toBe(true);
        await expectUnavailable(pending);
      }
    }
    release.resolve();
    // The cancellation race settles first; join the original work before checking effects.
    for (const { kind, pending } of closedRuns) {
      if (kind === "owner" || kind === "catalog") {
        await expectUnavailable(pending);
      } else {
        for (const entry of pending) {
          await waitForPendingBridgeSettlement([entry], { kind: "awaiting" });
          expect(entry.reply.take().ok).toBe(false);
        }
      }
    }
    await waitForPendingBridgeSettlement(live, {
      kind: "draining",
      requiredRequestIds: live.map((entry) => entry.id),
    });
    expect(live.map((entry) => entry.reply.take())).toEqual([
      { id: "live-note", ok: true, json: JSON.stringify({ ok: true }) },
    ]);
    const originals = await Promise.all(bridgeCalls);
    expect(originals).toHaveLength(requests.length * (2 + closedRuns.length) + live.length);
    expect(originals.every((entry) => entry === undefined)).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    for (const effect of [lookup, initialize, spawn, wait, prepareCollectors, subscribe]) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      scope: "runtime",
      swarmGroupId: "swarm:agent:main:main:run-swarm",
      kind: "log",
      text: "Still live",
    });
  } finally {
    const closing = cleanups.map((cleanup) => cleanup());
    release.resolve();
    await Promise.all(closing);
    await Promise.allSettled(bridgeCalls);
    vi.restoreAllMocks();
    vi.doUnmock("./code-mode-swarm.runtime.js");
    vi.doUnmock("./subagents/registry/subagent-registry.js");
    vi.doUnmock("./subagents/registry/subagent-registry-publication.js");
    vi.doUnmock("./tools/agents-wait-tool.js");
    vi.doUnmock("../sessions/session-lifecycle-events.js");
    vi.resetModules();
  }
});
