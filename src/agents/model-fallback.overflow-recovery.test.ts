import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { ContextEngine } from "../context-engine/types.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
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
