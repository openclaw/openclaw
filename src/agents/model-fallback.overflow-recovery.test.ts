import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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
  // mock-isolation: Synthetic model fixtures must not write a runtime model catalog.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  // mock-isolation: Provider attempts use fixed models without provider discovery or network I/O.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  // mock-isolation: Keep real recovery policy while controlling only the compaction backend.
  vi.doMock("../context-engine/registry.js", () => ({
    hasSameContextEngineInstance: (left: ContextEngine, right: ContextEngine) => left === right,
    resolveContextEngine: vi.fn(async () => ({ dispose: async () => {} })),
    resolveContextEngineOwnerPluginId: () => undefined,
    resolveLogicalTurnContextEngines: async () => {
      const engine: ContextEngine = {
        info: { id: "fixture", name: "Fixture context engine" },
        ingest: async () => ({ ingested: false }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact,
      };
      const ref = { engine, registeredId: "fixture" };
      return { configured: ref, configuredId: "fixture", fallback: ref };
    },
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

afterEach(clearRuntimeConfigSnapshot);

describe("embedded overflow recovery before model fallback", () => {
  it.each([
    { outcome: "fits after compaction", primaryRecovers: true, sideEffects: false },
    { outcome: "still rejected after compaction", primaryRecovers: false, sideEffects: false },
    { outcome: "side effects prevent replay", primaryRecovers: false, sideEffects: true },
  ])("handles $outcome", async ({ primaryRecovers, sideEffects }) => {
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

      if (primaryRecovers) {
        expect(events).toEqual(["mock-1", "compact", "mock-1"]);
        expect(result.model).toBe("mock-1");
        expect(result.attempts).toEqual([]);
      } else if (sideEffects) {
        expect(events).toEqual(["mock-1"]);
        expect(result.model).toBe("mock-1");
        expect(result.result.meta.replayInvalid).toBe(true);
        expect(result.attempts).toEqual([]);
      } else {
        expect(events).toEqual([
          "mock-1",
          "compact",
          "mock-1",
          "compact",
          "mock-1",
          "compact",
          "mock-1",
          "mock-2",
        ]);
        expect(result.model).toBe("mock-2");
        expect(result.attempts).toMatchObject([{ reason: "context_overflow" }]);
      }
      if (!sideEffects) {
        expect(result.result.payloads?.[0]?.text).toBe("Answer after recovery");
      }
    });
  });
});
