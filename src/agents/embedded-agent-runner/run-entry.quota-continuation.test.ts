import { describe, expect, it, vi } from "vitest";
import * as quotaContinuationOwner from "./quota-continuation.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import {
  makeResult,
  initialAttemptOptions,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";
const state = vi.hoisted(() => ({ runWithModelFallback: vi.fn(), selectAgentHarness: vi.fn() }));
vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => state.runWithModelFallback(params),
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: (params: { provider: string }) => state.selectAgentHarness(params),
}));
function createDirectHarness() {
  return {
    workspaceDir: "/tmp/workspace",
    preparation: { kind: "direct" as const },
    resolveRuntimeOverride: () => undefined,
  };
}
describe("logical quota continuation chain", () => {
  it("continues only after the quota source, never consuming an earlier embedded candidate twice", async () => {
    const token = { kind: "settled-quota-continuation" as const };
    const read = vi.spyOn(quotaContinuationOwner, "readQuotaContinuation").mockReturnValue(token);
    const chain = ["native-a", "embedded-b", "native-c", "embedded-d"].map((provider, index) => ({
      provider,
      model: `model-${index}`,
      routeOrigin: index === 0 ? ("requested" as const) : ("configured-fallback" as const),
      routeResolution: "raw" as const,
    }));
    const observed: string[] = [];
    state.selectAgentHarness.mockImplementation(({ provider }) => ({
      id: provider.startsWith("embedded") ? "openclaw" : "codex",
      contextEngineHostCapabilities: [],
    }));
    let search = 0;
    state.runWithModelFallback.mockImplementation(async (options: FallbackRunnerParams) => {
      const selected = search++ === 0 ? chain.slice(0, 3) : chain.slice(3);
      await options.prepareCandidateChain?.(search === 1 ? chain : selected);
      if (search > 1) {
        expect(options.provider).toBe("embedded-d");
        expect(options.fallbacksOverride).toEqual([]);
      }
      let result;
      for (const candidate of selected) {
        result = await options.run(
          candidate.provider,
          candidate.model,
          initialAttemptOptions(options),
        );
      }
      const last = selected.at(-1);
      if (!last || !result) {
        throw new Error("empty fixture chain");
      }
      return {
        outcome: "completed" as const,
        result,
        provider: last.provider,
        model: last.model,
        attempts: [],
      };
    });
    try {
      await runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "native-a", model: "model-0" },
        identity: { runId: "quota-cursor", agentId: "main", sessionId: "session" },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          options.quotaBudget?.initialize(10_000);
          observed.push(provider);
          return makeResult({
            provider,
            model,
            ...(provider === "native-c"
              ? {
                  meta: {
                    replayInvalid: true,
                    error: {
                      kind: "incomplete_turn",
                      message: "Quota exhausted",
                      fallbackSafe: false,
                    },
                  },
                }
              : provider === "embedded-d"
                ? {}
                : { classification: "empty" as const }),
          });
        },
      });
      expect(observed).toEqual(["native-a", "embedded-b", "native-c", "embedded-d"]);
    } finally {
      read.mockRestore();
    }
  });
});
