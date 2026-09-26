import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
import {
  activeRuns,
  createCodeModeBridgeDispatchState,
  createCodeModeRunOwner,
  disposeAllCodeModeRuns,
  reserveActiveRunSlot,
  storeSuspendedRun,
  type PendingBridgeState,
} from "./code-mode-state.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { createToolSearchCatalogRef, registerHeadlessToolSearchCatalog } from "./tool-search.js";

async function parkExpiringRun(method: "callValue" | "agentWait") {
  const rawConfig = {
    tools: { codeMode: { enabled: true, snapshotTtlSeconds: 1 } },
  } as never;
  const config = resolveCodeModeConfig(rawConfig);
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const ctx = { config: rawConfig, runtimeConfig: rawConfig, catalogRef };
  const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(config));
  const owner = createCodeModeRunOwner(ctx, config);
  const cancel = vi.fn();
  const pending: PendingBridgeState = {
    id: `bridge:${method}:1`,
    method,
    args: method === "agentWait" ? ["collector-1"] : ["openclaw:core:slow", {}],
    promise: new Promise(() => {}),
    reply: owner.inbox.createReply(`bridge:${method}:1`),
    cancel,
  };

  const continuation = {
    executor: "quickjs" as const,
    retainedBytes: 1,
    async resume() {
      throw new Error("unused test continuation");
    },
    async dispose() {},
  };
  await owner.retainContinuation(continuation);

  storeSuspendedRun({
    owner,
    replayId: "cm_replay_lifecycle",
    pending: [pending],
    replaySafe: false,
    settlementMode: { kind: "awaiting" },
    continuation,
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    runtime,
    catalogProjection: createCodeModeCatalogProjection([]),
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    output: new CodeModeOutputState(config.maxOutputBytes),
    bridgeDispatch: createCodeModeBridgeDispatchState(),
  });
  return { cancel, runId: owner.runId };
}

afterEach(async () => {
  await disposeAllCodeModeRuns();
  vi.useRealTimers();
});

describe("Code Mode run lifecycle", () => {
  it("rejects an unavailable run without leaking a capacity reservation", () => {
    expect(() => reserveActiveRunSlot("cm_missing_lifecycle_owner")).toThrow(
      "code mode run is unavailable or expired",
    );

    const release = reserveActiveRunSlot();
    release();
  });

  it("expires an idle suspended snapshot and aborts its outstanding tool", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { cancel, runId } = await parkExpiringRun("callValue");

    expect(activeRuns.has(runId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(activeRuns.has(runId)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains an active collector only within its bounded snapshot TTL windows", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { cancel, runId } = await parkExpiringRun("agentWait");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(activeRuns.has(runId)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(activeRuns.has(runId)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
