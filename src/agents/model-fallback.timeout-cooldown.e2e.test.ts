import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { createFallbackE2eMocks } from "./model-fallback.e2e.test-support.js";
import {
  createEmbeddedFallbackEntryRunner,
  makeModelFallbackConfig,
  readFallbackUsageStats,
  withModelFallbackWorkspace,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock =
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const fallbackMocks = createFallbackE2eMocks((params) => runEmbeddedAttemptMock(params));
// mock-isolation: keep model config writes out of the isolated fallback workspace.
vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

let runEmbeddedEntryFallback: ReturnType<typeof createEmbeddedFallbackEntryRunner>;

beforeAll(async () => {
  fallbackMocks.install();
  runEmbeddedEntryFallback = createEmbeddedFallbackEntryRunner({
    runEmbeddedAgent: (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
    runEmbeddedAgentEntry: (await import("./embedded-agent-runner/run-entry.js"))
      .runEmbeddedAgentEntry,
    createModelRoutingTestAdmission: (
      await import("./test-helpers/model-routing-decision-e2e-fixtures.js")
    ).createModelRoutingTestAdmission,
  });
});

beforeEach(() => {
  resetFallbackSkipCacheForTest();
  runEmbeddedAttemptMock.mockReset();
  fallbackMocks.clear();
});

function expectAttemptOrder(expected: Array<[string, string]>) {
  expect(
    runEmbeddedAttemptMock.mock.calls.map(([{ provider, authProfileId }]) => [
      provider,
      authProfileId,
    ]),
  ).toEqual(expected);
}

describe("timeout cooldown availability", () => {
  it.each(["idle", "request", "backup-profile", "fallback-model"] as const)(
    "records timeout cooldown only with an alternative: %s",
    async (scenario) => {
      await withModelFallbackWorkspace(async (workspace) => {
        const cfg = makeModelFallbackConfig();
        const hasBackup = scenario === "backup-profile";
        const hasFallback = scenario === "fallback-model";
        cfg.agents!.defaults!.model = {
          primary: "openai/mock-1",
          fallbacks: hasFallback ? ["groq/mock-2"] : [],
        };
        cfg.auth = { order: { openai: hasBackup ? ["openai:p1", "openai:p2"] : ["openai:p1"] } };
        // Stored credentials outside the authorized order must not enable cooldown.
        await writeFallbackMultiProfileAuthStore(workspace.agentDir, { openAiProfileCount: 2 });
        runEmbeddedAttemptMock.mockImplementation(async ({ provider, modelId }) => {
          const failed = runEmbeddedAttemptMock.mock.calls.length === 1;
          const assistant = buildEmbeddedRunnerAssistant({
            provider,
            model: modelId,
            stopReason: failed ? (scenario === "request" ? "error" : "aborted") : "stop",
            content: failed ? [] : [{ type: "text", text: "recovered" }],
            ...(failed ? { errorMessage: "LLM request timed out." } : {}),
          });
          return makeEmbeddedRunnerAttempt({
            providerRetryMaxRetries: 0,
            terminal:
              failed && scenario !== "request"
                ? { kind: "timeout", phase: "prompt", source: "idle", aborted: true }
                : { kind: "ok" },
            lastAssistant: assistant,
            assistantTexts: failed ? [] : ["recovered"],
          });
        });
        const run = async (name: string) => {
          const work = new AsyncWorkScope();
          try {
            return await work.run(() => runEmbeddedEntryFallback(workspace, name, { config: cfg }));
          } finally {
            await work.drain();
          }
        };

        await run(`timeout-${scenario}`).catch(() => undefined);
        const stats = (await readFallbackUsageStats(workspace.agentDir))["openai:p1"];
        if (hasBackup || hasFallback) {
          expect(stats?.cooldownReason).toBe("timeout");
          expect(stats?.cooldownUntil).toBeGreaterThan(Date.now());
          expectAttemptOrder([
            ["openai", "openai:p1"],
            hasBackup ? ["openai", "openai:p2"] : ["groq", "groq:p1"],
          ]);
        } else {
          expect(stats?.cooldownUntil).toBeUndefined();
          expect(stats?.failureCounts?.timeout).toBeUndefined();
          // Two immediate turns also cover the provider probe throttle closing.
          for (const name of ["following", "concurrent-peer"]) {
            const result = await run(`${name}-${scenario}`);
            expect(result.result.payloads?.[0]?.text).toBe("recovered");
          }
          expectAttemptOrder(Array.from({ length: 3 }, () => ["openai", "openai:p1"]));
        }
      });
    },
  );
});
