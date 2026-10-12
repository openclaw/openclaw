import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import type { AgentHarness } from "../harness/types.js";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedEnsureAuthProfileStore,
  mockedGetApiKeyForModel,
  mockedMarkAuthProfileFailure,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { guardRunWorkspaceOwnership } from "./run.workspace-ownership.test-support.js";

let runHarness: Awaited<ReturnType<typeof loadRunOverflowCompactionHarness>>;
beforeAll(async () => {
  runHarness = await loadRunOverflowCompactionHarness();
});

const failedProfile = "openai:failed";
const backupProfile = "openai:backup";

function permanentAuthFailure(): Error {
  return Object.assign(new Error("API key has been revoked"), {
    name: "ProviderAuthError",
    provider: "openai",
    profileId: failedProfile,
  });
}

function prepareAuthFailoverRun(
  nativeModelOwned = false,
  options: {
    nativeModelRef?: () => { provider: string; model: string } | undefined;
    rejectAuthoredRequests?: boolean;
  } = {},
) {
  const { registerPreparedAgentHarness, runEmbeddedAgent } = runHarness;
  registerPreparedAgentHarness({
    id: "codex",
    label: "Codex",
    authBootstrap: "harness",
    supports: ({ provider, modelProvider }) => {
      if (
        options.rejectAuthoredRequests &&
        modelProvider?.requestTransportOverrides === "present"
      ) {
        return {
          supported: false,
          reason: "native transport cannot reproduce authored requests",
          fallbackRuntime: "openclaw",
        };
      }
      return provider === "openai" ? { supported: true, priority: 100 } : { supported: false };
    },
    ...(nativeModelOwned
      ? {
          resolveSessionRuntimeOwnership: ({
            assertCurrent,
          }: Parameters<NonNullable<AgentHarness["resolveSessionRuntimeOwnership"]>>[0]) => {
            assertCurrent();
            const modelRef = options.nativeModelRef?.();
            return { model: "native", auth: "host", ...(modelRef ? { modelRef } : {}) } as const;
          },
        }
      : {}),
    runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
  });
  mockedEnsureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: {
      [failedProfile]: createApiKeyCredential("openai", "failed-api-key"),
      [backupProfile]: createApiKeyCredential("openai", "backup-api-key"),
    },
    order: { openai: [failedProfile, backupProfile] },
  });
  mockedResolveAuthProfileOrder.mockReturnValue([failedProfile, backupProfile]);
  mockedGetApiKeyForModel.mockImplementation(async ({ profileId } = {}) => ({
    apiKey: profileId === backupProfile ? "backup-api-key" : "failed-api-key",
    profileId: profileId ?? failedProfile,
    source: "test",
    mode: "api-key",
  }));
  return runEmbeddedAgent;
}

describe("native harness auth failover", () => {
  let state: OpenClawTestState;
  let guard: Awaited<ReturnType<typeof guardRunWorkspaceOwnership>>;
  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "harness-auth-failover" });
    guard = await guardRunWorkspaceOwnership(state);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ assistantTexts: ["OK"] }));
  });
  afterEach(async () => {
    try {
      guard?.verifyAndRestore();
    } finally {
      await state?.cleanup();
    }
  });
  async function createNativeHostRunParams() {
    const params = {
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.6-sol",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      authProfileId: failedProfile,
      authProfileIdSource: "auto" as const,
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: params.sessionKey },
      {
        sessionId: params.sessionId,
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    );
    return params;
  }

  it.each(["auto", "user"] as const)(
    "plans divergent native host-auth model selection while retaining %s profile strictness",
    async (authProfileIdSource) => {
      const modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => modelRef });
      const params = await createNativeHostRunParams();
      const failure = permanentAuthFailure();
      mockedRunEmbeddedAttempt
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));
      const run = runEmbeddedAgent({
        ...params,
        provider: "anthropic",
        model: "outer-model",
        authProfileIdSource,
      });
      if (authProfileIdSource === "user") {
        await expect(run).rejects.toBe(failure);
      } else {
        await expect(run).resolves.toMatchObject({ payloads: [{ text: "OK" }] });
        expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
          expect.objectContaining({ profileId: failedProfile, reason: "auth_permanent" }),
        );
      }
      expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: state.agentDir(),
          inheritedAuthDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
        }),
        expect.objectContaining({ retainIdleRunOwner: true }),
      );
      const attempts = mockedRunEmbeddedAttempt.mock.calls.map(([attempt]) => attempt);
      expect(attempts.map((attempt) => attempt.authProfileId)).toEqual(
        authProfileIdSource === "user" ? [failedProfile] : [failedProfile, backupProfile],
      );
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({
          provider: modelRef.provider,
          modelId: modelRef.model,
          expectedSessionRuntimeOwnership: { model: "native", auth: "host", modelRef },
        });
      }
      expect(mockedGetApiKeyForModel.mock.calls[0]?.[0]?.model).toMatchObject({
        provider: modelRef.provider,
        id: modelRef.model,
      });
    },
  );

  it.each(["outer-model", "actual-model"] as const)(
    "enforces native host-auth request controls from %s without changing runtime ownership",
    async (source) => {
      const modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(true, {
        nativeModelRef: () => modelRef,
        rejectAuthoredRequests: true,
      });
      const params = await createNativeHostRunParams();
      const configuredModel =
        source === "outer-model" ? "openai/gpt-5.6-sol" : "openai/gpt-5.6-luna";
      const runParams = {
        ...params,
        config: {
          agents: {
            defaults: {
              models: { [configuredModel]: { params: { responsesServerCompaction: true } } },
            },
          },
        },
      };
      if (source === "outer-model") {
        await expect(runEmbeddedAgent(runParams)).resolves.toMatchObject({
          payloads: [{ text: "OK" }],
        });
        expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
          provider: "openai",
          modelId: "gpt-5.6-luna",
        });
      } else {
        await expect(runEmbeddedAgent(runParams)).rejects.toMatchObject({
          name: "AgentHarnessPreflightError",
        });
        expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects native host-auth ownership without a model tuple instead of borrowing the outer model", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => undefined });
    const params = await createNativeHostRunParams();
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ assistantTexts: ["must not infer"] }),
    );
    await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
    });
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it.each(["model", "provider"] as const)(
    "rejects a native host-auth %s change after host credential preparation",
    async (field) => {
      let modelRef = { provider: "openai", model: "gpt-5.6-luna" };
      const runEmbeddedAgent = prepareAuthFailoverRun(true, { nativeModelRef: () => modelRef });
      const params = await createNativeHostRunParams();
      mockedGetApiKeyForModel.mockImplementation(async ({ profileId } = {}) => {
        modelRef = {
          ...modelRef,
          [field]: field === "model" ? "gpt-5.6-sol" : "different-native-provider",
        };
        return {
          apiKey: "prepared-key",
          profileId: profileId ?? failedProfile,
          source: "test",
          mode: "api-key",
        };
      });
      mockedRunEmbeddedAttempt.mockResolvedValue(
        makeAttemptResult({ assistantTexts: ["must not infer"] }),
      );
      await expect(runEmbeddedAgent(params)).rejects.toMatchObject({
        name: "AgentHarnessPreflightError",
      });
      expect(mockedGetApiKeyForModel).toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    },
  );

  it("uses a prepared harness auth attempt instead of waiting an above-cap rate-limit floor", async () => {
    const helpers = await vi.importActual<typeof import("../embedded-agent-helpers.js")>(
      "../embedded-agent-helpers.js",
    );
    mockedClassifyFailoverReason.mockImplementation(helpers.classifyFailoverReason);
    mockedClassifyAssistantFailoverReason.mockImplementation(
      helpers.classifyAssistantFailoverReason,
    );
    mockedIsFailoverAssistantError.mockImplementation(helpers.isFailoverAssistantError);
    mockedIsRateLimitAssistantError.mockImplementation(helpers.isRateLimitAssistantError);
    const runEmbeddedAgent = prepareAuthFailoverRun();
    const { sleepWithAbort } = await import("../../infra/backoff.js");
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          providerRetryMaxRetries: 3,
          providerRetryMaxDelayMs: 30_000,
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "gpt-5.6-luna",
            stopReason: "error",
            errorMessage: "429 Too Many Requests: Please try again later.",
            errorType: "rate_limit_error",
            errorBody: JSON.stringify({ headers: { "retry-after": "9897" } }),
          }),
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        modelFallbacksOverride: [],
        authProfileId: failedProfile,
        authProfileIdSource: "auto",
        runId: "run-native-harness-rate-limit-cap",
      }),
    ).resolves.toMatchObject({ payloads: [{ text: "OK" }] });
    expect(mockedRunEmbeddedAttempt.mock.calls.map(([params]) => params.authProfileId)).toEqual([
      failedProfile,
      backupProfile,
    ]);
    expect(vi.mocked(sleepWithAbort).mock.calls.map(([delay]) => delay)).not.toContain(9_897_000);
  });

  it("does not rotate or mark profiles for a preflight harness failure", async () => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    // The harness resets modules before loading the runtime.
    const { AgentHarnessPreflightError } = await import("../harness/errors.js");
    const failure = new AgentHarnessPreflightError("handoff refused; reconnect before continuing", {
      cause: permanentAuthFailure(),
    });
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);
    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        runId: "run-native-harness-non-auth-failure",
      }),
    ).rejects.toBe(failure);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it.each([
    [
      "CODEX_NODE_EXEC_APPROVAL_EXPIRED",
      "Codex node execution approval expired before a decision. Retry the action and approve the new request.",
    ],
  ])("preserves %s without rotating or failing healthy profiles", async (code, message) => {
    const runEmbeddedAgent = prepareAuthFailoverRun();
    const { GatewayClientRequestError } =
      await import("../../../packages/gateway-client/src/request-error.js");
    const { resolveModelFallbackError } = await import("../failover-error.js");
    const { buildExternalRunFailureReply } =
      await import("../../auto-reply/reply/agent-runner-failure-reply.js");
    const failure = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message,
      details: { code },
    });
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-sol",
        agentHarnessId: "codex",
        authProfileId: failedProfile,
        authProfileIdSource: "auto",
      }),
    ).rejects.toBe(failure);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(resolveModelFallbackError(failure)).toEqual({ kind: "coordination", error: failure });
    expect(
      buildExternalRunFailureReply({ error: failure, message: `${message} | INVALID_REQUEST` }),
    ).toEqual({
      text: `⚠️ ${message}`,
      isGenericRunnerFailure: false,
    });
  });

  it.each(["401 Unauthorized"])(
    "still records genuine harness auth failure and shows sign-in guidance: %s",
    async (message) => {
      const runEmbeddedAgent = prepareAuthFailoverRun();
      mockedResolveAuthProfileOrder.mockReturnValue([failedProfile]);
      const { buildExternalRunFailureReply } =
        await import("../../auto-reply/reply/agent-runner-failure-reply.js");
      const failure = new Error(message);
      mockedRunEmbeddedAttempt.mockRejectedValueOnce(failure);

      await expect(
        runEmbeddedAgent({
          ...createOverflowRunParams(state),
          provider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          authProfileId: failedProfile,
          authProfileIdSource: "auto",
        }),
      ).rejects.toBe(failure);
      expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: failedProfile, reason: "auth" }),
      );
      expect(buildExternalRunFailureReply({ error: failure, message }).text).toBe(
        "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
      );
    },
  );
});
