import { expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

it("keeps latest physical-attempt metadata on retry exhaustion", async ({ onTestFinished }) => {
  const runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  resetSharedRunIntegrationHarnessMocks();
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  const state = await createOpenClawTestState({ label: "run.retry-limit" });
  onTestFinished(() => state.cleanup());
  const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
  setRuntimeConfigSnapshot({});
  useOpenAIPlatformAuthFixture();
  const credentialSource = {
    kind: "direct",
    evidence: "environment",
    authorization: "ambient",
  } as const;
  let physicalAttempt = 0;
  mockedBuildAgentRuntimePlan.mockImplementation(() => {
    physicalAttempt += 1;
    return {
      resolvedRef: { provider: "openai", modelId: "gpt-5.6-luna" },
      auth: {
        authProfileProviderForAuth: "openai",
        providerForAuth: "openai",
        credentialSource: physicalAttempt === 32 ? { ...credentialSource } : { kind: "profile" },
      },
      observability: {
        resolvedRef: "openai/gpt-5.6-luna",
        provider: "openai",
        modelId: "gpt-5.6-luna",
        harnessId: "codex",
      },
    } as never;
  });
  const accepted = {
    runId: "collector-before-retry",
    childSessionKey: "agent:main:subagent:collector",
    expectsCompletionMessage: false,
  };
  mockedRunEmbeddedAttempt.mockImplementation(async () =>
    makeAttemptResult({
      acceptedSessionSpawns: physicalAttempt === 1 ? [accepted] : [],
      preflightRecovery: {
        route: "truncate_tool_results_only",
        source: "mid-turn",
        handled: true,
        truncatedCount: 0,
      },
    }),
  );

  const result = await runEmbeddedAgent({
    ...createOverflowRunParams(state),
    provider: "openai",
    model: "gpt-5.6-luna",
    runId: "run-retry-limit-physical-attempt-meta",
  });

  expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
  expect(result.acceptedSessionSpawns).toEqual([accepted]);
  expect(result.meta).toMatchObject({
    error: { kind: "retry_limit" },
    agentMeta: { provider: "openai", model: "gpt-5.6-luna" },
  });
  expect(result.meta.agentMeta?.credentialSource).toEqual(credentialSource);
});
