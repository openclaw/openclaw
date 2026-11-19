import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { AgentHarnessModelRequestPolicyError } from "./harness/errors.js";
import type { ModelFallbackStepFields } from "./model-fallback-observation.js";
import { createFallbackE2eMocks } from "./model-fallback.e2e.test-support.js";
import { createModelFallbackAttemptMocks } from "./model-fallback.run-embedded.attempts.test-support.js";
import {
  RATE_LIMIT_ERROR_MESSAGE,
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
  expect(runEmbeddedAttemptMock.mock.calls.map(([p]) => [p.provider, p.authProfileId])).toEqual(
    expected,
  );
}

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

const { mockPrimaryFailureThenFallbackSuccess, mockPrimaryErrorThenFallbackSuccess } =
  createModelFallbackAttemptMocks(runEmbeddedAttemptMock);
async function runEntryGuard(
  workspace: { agentDir: string; workspaceDir: string },
  name: string,
  options: Parameters<typeof runEmbeddedEntryFallback>[2] = {},
) {
  const work = new AsyncWorkScope();
  try {
    return await work.run(() => runEmbeddedEntryFallback(workspace, name, options));
  } finally {
    await work.drain();
  }
}
it("does not rotate credentials or run a second model after a confirmed deployment denial", async () => {
  await withModelFallbackWorkspace(async (workspace) => {
    await writeFallbackMultiProfileAuthStore(workspace.agentDir);
    const denial = new AgentHarnessModelRequestPolicyError();
    mockPrimaryFailureThenFallbackSuccess(() =>
      makeEmbeddedRunnerAttempt({ terminal: { kind: "failed", source: "prompt", error: denial } }),
    );
    await expect(runEntryGuard(workspace, "request-policy-denial")).rejects.toBe(denial);
    expect(runEmbeddedAttemptMock).toHaveBeenCalledOnce();
    const stats = await readFallbackUsageStats(workspace.agentDir);
    expect(stats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(stats["openai:p1"]?.failureCounts).toBeUndefined();
  });
});
it("preserves attempt timeout fallback eligibility after committed tool effects", async () => {
  await withModelFallbackWorkspace(async (workspace) => {
    await writeFallbackMultiProfileAuthStore(workspace.agentDir);
    mockPrimaryFailureThenFallbackSuccess(() =>
      makeEmbeddedRunnerAttempt({
        terminal: { kind: "timeout", phase: "prompt", source: "run_budget", aborted: true },
        lastAssistant: buildEmbeddedRunnerAssistant({ stopReason: "aborted" }),
        toolMetas: [{ toolName: "write", replaySafe: false }],
      }),
    );
    await runEntryGuard(workspace, "attempt-timeout");
    expect(runEmbeddedAttemptMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAttemptMock.mock.calls[0]?.[0].provider).toBe("openai");
  });
});
it("does not replay thrown transcript turn assertions through retries or model fallback", async () => {
  await withModelFallbackWorkspace(async (workspace) => {
    await writeFallbackMultiProfileAuthStore(workspace.agentDir);
    const message =
      'Transcript idempotency key "channel-user:v1:conflicting-input" conflicts with the admitted message.';
    runEmbeddedAttemptMock.mockRejectedValue(new Error(message));
    const result = await runEntryGuard(workspace, "transcript-assertion", {
      runId: "announce:requester-settle:test:transcript-assertion",
      fallbacksOverride: ["groq/mock-2", "groq/mock-3"],
    }).catch((error: unknown) => error);
    expect(runEmbeddedAttemptMock).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ message });
    expect(fallbackMocks.suspendSessionMock).not.toHaveBeenCalled();
  });
});
it("keeps a pinned model on its rate-limit surface instead of escalating to fallback", async () => {
  await withModelFallbackWorkspace(async (workspace) => {
    await writeFallbackMultiProfileAuthStore(workspace.agentDir);
    mockPrimaryErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);
    const steps: ModelFallbackStepFields[] = [];
    await expect(
      runEntryGuard(workspace, "user-model-override-rate-limit", {
        fallbacksOverride: [],
        modelFallbackAvailability: { kind: "disabled_by_model_override" },
        onFallbackStep: (step) => steps.push(step),
      }),
    ).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      provider: "openai",
      model: "mock-1",
      rateLimitRetriesExhausted: 3,
      suspend: true,
    });
    expect(runEmbeddedAttemptMock.mock.calls.length).toBeGreaterThan(2);
    expect(
      runEmbeddedAttemptMock.mock.calls.every(([attempt]) => attempt.provider === "openai"),
    ).toBe(true);
    expect(steps.map((step) => step.fallbackStepFinalOutcome)).toEqual(["chain_exhausted"]);
    expect(steps[0]?.fallbackStepToModel).toBeUndefined();
  });
});
