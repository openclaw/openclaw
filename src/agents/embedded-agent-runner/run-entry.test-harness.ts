import { beforeEach, expect, vi } from "vitest";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import {
  initialAttemptOptions,
  fallbackAttemptOptions,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";

const state = vi.hoisted(() => ({
  runWithModelFallback: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(async (_params: unknown) => undefined),
  selectAgentHarness: vi.fn(({ provider }: { provider: string }) => ({
    id: provider === "fallback-provider" ? "fallback-harness" : "primary-harness",
    contextEngineHostCapabilities: [],
  })),
  discardedAttempts: [] as string[],
  finalizedAttempts: [] as string[],
}));

vi.mock("../harness/context-engine-turn-attempt.js", () => ({
  discardContextEngineTurnAttemptIntent: vi.fn(
    ({ facts }: { facts: ContextEngineTurnAttemptFacts }) => {
      state.discardedAttempts.push(facts.sessionIdUsed);
    },
  ),
  finalizeAcceptedContextEngineTurn: vi.fn(async ({ facts }) => {
    state.finalizedAttempts.push(facts.sessionIdUsed);
  }),
}));

vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => state.runWithModelFallback(params),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (params: unknown) =>
    state.ensureSelectedAgentHarnessPlugin(params),
}));

vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: (params: { provider: string }) => state.selectAgentHarness(params),
}));

export const { runEmbeddedAgentEntry } = await import("./run-entry.js");

export function setupRunEntryTestState() {
  beforeEach(() => {
    state.discardedAttempts.length = 0;
    state.finalizedAttempts.length = 0;
    state.ensureSelectedAgentHarnessPlugin.mockReset().mockResolvedValue(undefined);
    state.selectAgentHarness
      .mockReset()
      .mockImplementation(({ provider }: { provider: string }) => ({
        id: provider === "fallback-provider" ? "fallback-harness" : "primary-harness",
        contextEngineHostCapabilities: [],
      }));
    state.runWithModelFallback
      .mockReset()
      .mockImplementation(async (params: FallbackRunnerParams) => {
        await params.prepareCandidateChain?.([
          {
            provider: params.provider,
            model: params.model,
            routeOrigin: "requested",
            routeResolution: "raw",
          },
          {
            provider: "fallback-provider",
            model: "fallback-model",
            routeOrigin: "configured-fallback",
            routeResolution: "raw",
          },
        ]);
        await params.prepareAgentHarnessRuntime?.({
          provider: params.provider,
          model: params.model,
          agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(
            params.provider,
            params.model,
          ),
        });
        const primaryResult = await params.run(params.provider, params.model, {
          ...initialAttemptOptions(params),
          allowTransientCooldownProbe: true,
        });
        const classification = await params.classifyResult?.({
          result: primaryResult,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 2,
        });
        expect(classification).toBeTruthy();
        const fallbackProvider = "fallback-provider";
        const fallbackModel = "fallback-model";
        await params.prepareAgentHarnessRuntime?.({
          provider: fallbackProvider,
          model: fallbackModel,
          agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(
            fallbackProvider,
            fallbackModel,
          ),
        });
        const result = await params.run(fallbackProvider, fallbackModel, {
          ...fallbackAttemptOptions(params, "format"),
          isFinalFallbackAttempt: true,
        });
        return {
          outcome: "completed" as const,
          result,
          provider: fallbackProvider,
          model: fallbackModel,
          attempts: [
            {
              provider: params.provider,
              model: params.model,
              error: "empty result",
              reason: "format" as const,
            },
          ],
        };
      });
  });

  return state;
}
