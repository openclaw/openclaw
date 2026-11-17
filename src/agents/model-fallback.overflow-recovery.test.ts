import { describe } from "vitest";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { type OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine } from "../context-engine/types.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { buildEmbeddedRunBlockedResult } from "./embedded-agent-runner/run/blocked-run-result.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { type EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError } from "./failover-error.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { model as catalogModel } from "./model-catalog-fixtures.test-support.js";
import {
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runAttempt = vi.fn<(params: { modelId: string }) => Promise<EmbeddedRunAttemptResult>>();
const compact = vi.fn<ContextEngine["compact"]>();
type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let runEmbeddedAgent: (
  params: Omit<Parameters<ProductionRunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunEmbeddedAgent>;
let runWithModelFallback: typeof import("./model-fallback-runner.js").runWithModelFallback;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: runAttempt });
  const { resolveLogicalTurnContextEngines } = await import("../context-engine/registry.js");
  const engines = await resolveLogicalTurnContextEngines();
  const engine: ContextEngine = {
    ...engines.configured.engine,
    info: { id: "fixture", name: "Fixture context engine" },
    compact,
  };
  const ref = { engine, registeredId: engine.info.id };
  vi.mocked(resolveLogicalTurnContextEngines).mockResolvedValue({
    configured: ref,
    configuredId: "fixture",
    fallback: ref,
  });
  // mock-isolation: Synthetic model fixtures must not write a runtime model catalog.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  // mock-isolation: Provider attempts use fixed models without provider discovery or network I/O.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(
    (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
  );
  ({ runWithModelFallback } = await import("./model-fallback-runner.js"));
});

beforeEach(() => {
  runAttempt.mockReset();
  compact.mockReset();
  resetFallbackSkipCacheForTest();
});

// withModelFallbackWorkspace clears runtime config after closing each case.
it.each([
  ["recovery", true, false, "mock-1 compact mock-1"],
  ["exhaustion", false, false, "mock-1 compact mock-1 compact mock-1 compact mock-1 mock-2"],
  ["side effects prevent replay", false, true, "mock-1"],
] as const)("handles overflow %s", async (_outcome, primaryRecovers, sideEffects, order) => {
  await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
    const events: string[] = [];
    compact.mockImplementation(async () => {
      events.push("compact");
      return {
        ok: true,
        compacted: true,
        result: { summary: "History summary", tokensBefore: 20_000, tokensAfter: 8_000 },
      };
    });
    runAttempt.mockImplementation(async ({ modelId }) => {
      events.push(modelId);
      if (modelId === "mock-1" && !(primaryRecovers && compact.mock.calls.length > 0)) {
        return makeEmbeddedRunnerAttempt({
          terminal: {
            kind: "failed",
            source: "prompt",
            error: new Error("request_too_large: Request size exceeds model context window"),
          },
          ...(sideEffects ? { toolMetas: [{ toolName: "write", replaySafe: false }] } : {}),
        });
      }
      return makeEmbeddedRunnerAttempt({
        assistantTexts: ["Answer after recovery"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          model: modelId,
          content: [{ type: "text", text: "Answer after recovery" }],
        }),
      });
    });
    const cfg = makeModelFallbackConfig();
    setRuntimeConfigSnapshot(cfg);
    const sessionManager = SessionManager.inMemory(workspaceDir);
    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "mock-1",
      agentDir,
      manifestPlugins: [],
      skipAuthProfileRuntime: true,
      classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
      run: (provider, model) =>
        runEmbeddedAgent({
          sessionId: "overflow-recovery",
          sessionKey: "agent:test:overflow-recovery",
          sessionManager,
          sessionPersistence: "detached",
          workspaceDir,
          agentDir,
          config: cfg,
          prompt: "Summarize the history",
          provider,
          model,
          timeoutMs: 5_000,
          runId: "overflow-recovery",
          enqueue: async (task) => task(),
        }),
    });

    expect(events).toEqual(order.split(" "));
    expect(result).toMatchObject({
      model: primaryRecovers || sideEffects ? "mock-1" : "mock-2",
      attempts: primaryRecovers || sideEffects ? [] : [{ reason: "context_overflow" }],
    });
    if (sideEffects) {
      expect(result.result.meta.replayInvalid).toBe(true);
    } else {
      expect(result.result.payloads?.[0]?.text).toBe("Answer after recovery");
    }
  });
});

describe("context overflow model fallback", () => {
  const guidance = "This message exceeds the model's context window on its own.";
  const overflow = "Context window exceeded: requested 12000 tokens";
  const defaults = {
    provider: "fixture-overflow",
    model: "primary",
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
    classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
  };
  const answer: EmbeddedAgentRunResult = {
    payloads: [{ text: "The fallback answered." }],
    meta: { durationMs: 1 },
  };
  type FallbackParams = Parameters<typeof runWithModelFallback<EmbeddedAgentRunResult>>[0];
  const runFallback = (run: FallbackParams["run"], options: Partial<FallbackParams> = {}) =>
    runWithModelFallback({ ...defaults, cfg: makeConfig(), run, ...options });
  const overloaded = () => new FailoverError("temporarily overloaded", { reason: "overloaded" });
  const attemptedModels = (run: { mock: { calls: unknown[][] } }) =>
    run.mock.calls.map((call) => call[1]);
  function makeConfig(fallbacks = ["capped", "fit-first", "fit-second"]): OpenClawConfig {
    const model = {
      primary: "fixture-overflow/primary",
      fallbacks: fallbacks.map((id) => `fixture-overflow/${id}`),
    };
    const definition = (id: string, contextWindow: number, contextTokens: number) =>
      catalogModel(id, id, { contextWindow, contextTokens });
    const provider = {
      baseUrl: "http://127.0.0.1:11434",
      models: [
        definition("primary", 32768, 8192),
        definition("capped", 131072, 4096),
        definition("fit-first", 32768, 16384),
        definition("fit-second", 65536, 32768),
      ],
    };
    return {
      agents: { defaults: { model } },
      models: { providers: { "fixture-overflow": provider } },
    };
  }
  function blocked(
    kind: "context_overflow" | "compaction_failure" = "context_overflow",
    message = overflow,
  ): EmbeddedAgentRunResult {
    return buildEmbeddedRunBlockedResult({
      text: guidance,
      errorKind: kind,
      errorMessage: message,
      durationMs: 1,
      agentMeta: {
        sessionId: "overflow-fixture",
        provider: defaults.provider,
        model: defaults.model,
        contextTokens: 8192,
      },
      replayInvalid: false,
    });
  }
  it.each(["context_overflow"] as const)(
    "prefers sufficient effective context caps after surfaced %s recovery",
    async (kind) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce(blocked(kind))
        .mockRejectedValueOnce(overloaded())
        .mockResolvedValueOnce(answer);
      const onFallbackStep = vi.fn();
      const result = await runFallback(run, { onFallbackStep });

      expect(attemptedModels(run)).toEqual(["primary", "fit-first", "fit-second"]);
      expect(result).toMatchObject({ outcome: "completed", model: "fit-second", result: answer });
      expect(result.attempts[0]).toMatchObject({ model: "primary", reason: "context_overflow" });
      expect(onFallbackStep).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbackStepFromModel: "fixture-overflow/primary",
          fallbackStepToModel: "fixture-overflow/fit-first",
          fallbackStepFromFailureReason: "context_overflow",
        }),
      );
    },
  );
  it("preserves the blocked guidance after every candidate rejects the oversized request", async () => {
    const run = vi.fn().mockResolvedValue(blocked());
    const result = await runFallback(run);
    expect(attemptedModels(run)).toEqual(["primary", "fit-first", "fit-second", "capped"]);
    expect(result).toMatchObject({
      outcome: "exhausted",
      result: {
        payloads: [{ text: guidance, isError: true }],
        meta: { error: { kind: "context_overflow" } },
      },
    });
  });
  it.each(["replay-invalid", "delivered", "empty override"] as const)(
    "does not replay %s overflow results",
    async (guard) => {
      const failure = blocked();
      if (guard === "replay-invalid") {
        failure.meta.replayInvalid = true;
      } else if (guard === "delivered") {
        failure.messagingToolSentTexts = ["Already delivered."];
      }
      const run = vi.fn().mockResolvedValue(failure);
      const result = await runFallback(
        run,
        guard === "empty override" ? { fallbacksOverride: [] } : {},
      );
      expect(run).toHaveBeenCalledOnce();
      expect(result.result).toBe(failure);
      if (guard === "empty override") {
        expect(result.outcome).toBe("exhausted");
      }
    },
  );
});
