import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import { createRunFixture } from "./code-mode-lifecycle.test-support.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { toToolSearchConfig } from "./code-mode-runtime.js";
import {
  activeRuns,
  disposeAllCodeModeRuns,
  reserveActiveRunSlot,
  storeSuspendedRun,
} from "./code-mode-state.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";

async function parkExpiringRun(method: "callValue" | "agentWait") {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { config, ctx, owner, continuation } = createRunFixture({
    tools: { codeMode: { enabled: true, snapshotTtlSeconds: 1 } },
  });
  const cancel = vi.fn();
  await owner.retainContinuation(continuation);

  storeSuspendedRun({
    owner,
    replayId: "cm_replay_lifecycle",
    pending: [
      {
        id: `bridge:${method}:1`,
        method,
        args: method === "agentWait" ? ["collector-1"] : ["openclaw:core:slow", {}],
        reply: owner.inbox.createReply(`bridge:${method}:1`),
        cancel,
      },
    ],
    replaySafe: false,
    settlementMode: { kind: "awaiting" },
    continuation,
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    runtime: new ToolSearchRuntime(ctx, toToolSearchConfig(config)),
    catalogProjection: createCodeModeCatalogProjection([]),
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    output: new CodeModeOutputState(config.maxOutputBytes),
    bridgeDispatch: { started: false },
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

  it.each(["callValue", "agentWait"] as const)("bounds suspended %s lifetime", async (method) => {
    const { cancel, runId } = await parkExpiringRun(method);
    expect(activeRuns.has(runId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    if (method === "agentWait") {
      expect(activeRuns.has(runId)).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(activeRuns.has(runId)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
