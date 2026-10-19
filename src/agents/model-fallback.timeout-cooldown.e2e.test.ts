import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { createFallbackE2eMocks } from "./model-fallback.e2e.test-support.js";
import {
  type EmbeddedAttemptParams,
  makeModelFallbackConfig,
  readFallbackUsageStats,
  withModelFallbackWorkspace,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const fallbackMocks = createFallbackE2eMocks((params) => runEmbeddedAttemptMock(params));
// mock-isolation: keep model config writes out of the isolated fallback workspace.
vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let runEmbeddedAgentEntry: typeof import("./embedded-agent-runner/run-entry.js").runEmbeddedAgentEntry;
let createModelRoutingTestAdmission: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").createModelRoutingTestAdmission;

beforeAll(async () => {
  fallbackMocks.install();
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ runEmbeddedAgentEntry } = await import("./embedded-agent-runner/run-entry.js"));
  ({ createModelRoutingTestAdmission } =
    await import("./test-helpers/model-routing-decision-e2e-fixtures.js"));
});

beforeEach(() => {
  resetFallbackSkipCacheForTest();
  runEmbeddedAttemptMock.mockReset();
  fallbackMocks.clear();
});

type Workspace = { agentDir: string; workspaceDir: string };

async function runEmbeddedEntryFallback(
  workspace: Workspace,
  name: string,
  options: { config: OpenClawConfig },
) {
  const cfg = options.config;
  const runId = `run:${name}`;
  const sessionKey = `agent:test:${name}`;
  const sessionId = `session:${runId}`;
  setRuntimeConfigSnapshot(cfg, cfg);
  const preparedRunAdmission = createModelRoutingTestAdmission({
    cfg: { ...cfg, logging: { audit: { executionIdentity: true } } },
    runId,
    boundary: "model-fallback-e2e",
  });
  try {
    return await runEmbeddedAgentEntry({
      selection: {
        cfg,
        provider: "openai",
        model: "mock-1",
        agentDir: workspace.agentDir,
        manifestPlugins: [],
      },
      identity: { runId, agentId: "test", sessionId, sessionKey },
      harness: {
        workspaceDir: workspace.workspaceDir,
        sessionKey,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
        resolveContextEngineHost: (provider, model) => ({
          id: `embedded-e2e:${provider}/${model}`,
          label: "embedded runner e2e",
          capabilities: [],
        }),
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      runCandidate: (provider, model, attemptOptions) =>
        runEmbeddedAgent({
          ...workspace,
          runId,
          sessionKey,
          sessionId,
          config: cfg,
          prompt: "hello",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          enqueue: async (task) => await task(),
          preparedRunAdmission,
          provider,
          model,
          modelRoutingProvenance: attemptOptions.modelRoutingProvenance,
          isFinalFallbackAttempt: attemptOptions.isFinalFallbackAttempt,
          contextEngineLogicalTurnLease: attemptOptions.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: attemptOptions.onContextEngineTurnCandidate,
        }),
    });
  } finally {
    preparedRunAdmission.close();
  }
}

function expectAttemptOrder(expected: Array<{ provider: string; authProfileId: string }>) {
  expect(
    runEmbeddedAttemptMock.mock.calls.map(([params]) => {
      const { provider, authProfileId } = params as EmbeddedRunAttemptParams;
      return { provider, authProfileId };
    }),
  ).toEqual(expected);
}

function profileAttempts(provider: string, count: number) {
  return Array.from({ length: count }, () => ({ provider, authProfileId: `${provider}:p1` }));
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
        runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
          const { provider, modelId } = params as EmbeddedAttemptParams;
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
            currentAttemptAssistant: assistant,
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
            { provider: "openai", authProfileId: "openai:p1" },
            hasBackup
              ? { provider: "openai", authProfileId: "openai:p2" }
              : { provider: "groq", authProfileId: "groq:p1" },
          ]);
        } else {
          expect(stats?.cooldownUntil).toBeUndefined();
          expect(stats?.failureCounts?.timeout).toBeUndefined();
          // Two immediate turns also cover the provider probe throttle closing.
          for (const name of ["following", "concurrent-peer"]) {
            const result = await run(`${name}-${scenario}`);
            expect(result.result.payloads?.[0]?.text).toBe("recovered");
          }
          expectAttemptOrder(profileAttempts("openai", 3));
        }
      });
    },
  );
});
