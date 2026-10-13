import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import { markAuthProfileSuccess } from "../auth-profiles.js";
import {
  clearAllRuntimeAuthMaterializations,
  getPreparedRuntimeAuthMaterializations,
  registerRuntimeAuthMaterializationMutationListener,
} from "../auth-profiles/runtime-materializations.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { copyAttemptDeliveryState } from "./run/attempt-delivery-state.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./run/auth-profile-success.js";

vi.mock("../auth-profiles.js", () => ({
  markAuthProfileSuccess: vi.fn(),
}));

const mockedMarkAuthProfileSuccess = vi.mocked(markAuthProfileSuccess);

describe("markEmbeddedRunAuthProfileSuccess", () => {
  beforeEach(() => {
    mockedMarkAuthProfileSuccess.mockReset();
  });

  it("does not wait for post-run success bookkeeping", () => {
    const pendingSuccess = new Promise<void>(() => {});
    mockedMarkAuthProfileSuccess.mockReturnValueOnce(pendingSuccess);

    const result = markEmbeddedRunAuthProfileSuccess({
      profileId: "openai:test-profile",
      profileStore: { version: 1, profiles: {} } as AuthProfileStore,
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(result).toBeUndefined();
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledOnce();
  });
});

describe("reportEmbeddedRunSuccessfulAuthBinding", () => {
  const profileStore = {
    version: 1 as const,
    profiles: {
      "openai:work": {
        type: "api_key" as const,
        provider: "openai",
        keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
      },
    },
  };

  const bindingInput = {
    profileId: "openai:work",
    profileStore,
    apiKeyInfo: null,
    attempt: makeAttemptResult(),
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "openai-responses",
    requestTransportOverrides: "none",
    agentHarnessId: "codex",
    pluginHarnessOwnsTransport: true,
    pluginHarnessOwnsAuthBootstrap: true,
  } satisfies Parameters<typeof reportEmbeddedRunSuccessfulAuthBinding>[0];

  afterEach(() => {
    clearAllRuntimeAuthMaterializations();
  });

  it("publishes an identical prepared API-key success only once", () => {
    const listener = vi.fn();
    const unregister = registerRuntimeAuthMaterializationMutationListener(listener);
    const agentDir = "/tmp/openclaw-auth-success-dedup";
    const input = {
      ...bindingInput,
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:work",
        mode: "api-key" as const,
        profileId: "openai:work",
      },
      agentDir,
      modelBaseUrl: "https://api.openai.com/v1",
    };

    try {
      reportEmbeddedRunSuccessfulAuthBinding(input);
      reportEmbeddedRunSuccessfulAuthBinding(input);

      expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
        expect.objectContaining({
          authMode: "api-key",
          authProfileId: "openai:work",
          runtimeOwnerId: "codex",
        }),
      ]);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("rejects prepared auth with non-profile provenance", () => {
    reportEmbeddedRunSuccessfulAuthBinding({
      ...bindingInput,
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "env:OPENAI_API_KEY",
        mode: "api-key",
        profileId: "openai:work",
      },
      agentDir: "/tmp/openclaw-auth-success-negative",
      modelBaseUrl: "https://api.openai.com/v1",
    });

    expect(getPreparedRuntimeAuthMaterializations("/tmp/openclaw-auth-success-negative")).toEqual(
      [],
    );
  });

  it("uses a harness-owned SecretRef fingerprint when the harness resolves it", () => {
    const onSuccessfulAuthBinding = vi.fn();

    reportEmbeddedRunSuccessfulAuthBinding({
      ...bindingInput,
      attempt: {
        ...bindingInput.attempt,
        authBindingFingerprint: "resolved-secretref-fingerprint",
      },
      onSuccessfulAuthBinding,
    });

    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith({
      authProfileId: "openai:work",
      agentHarnessId: "codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      authFingerprint: "resolved-secretref-fingerprint",
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
    });
  });

  it("binds opaque harness auth to the exact captured runtime artifact", () => {
    const onSuccessfulAuthBinding = vi.fn();
    const runtimeArtifact = {
      id: "codex-app-server:test",
      fingerprint: "codex-runtime-fingerprint",
    };

    reportEmbeddedRunSuccessfulAuthBinding({
      ...bindingInput,
      attempt: { ...bindingInput.attempt, runtimeArtifact },
      onSuccessfulAuthBinding,
    });

    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith({
      authProfileId: "openai:work",
      agentHarnessId: "codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      runtimeOwnerFingerprint: expect.any(String),
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
      runtimeArtifactId: runtimeArtifact.id,
      runtimeArtifactFingerprint: runtimeArtifact.fingerprint,
    });
  });
});

describe("overflow loop owner policies", () => {
  it("retains bounded ordered delivery facts and source finality across generations", () => {
    const target = {
      tool: "message",
      provider: "telegram",
      accountId: "main",
      to: "telegram:123",
      threadId: "456",
      text: "progress",
      sourceReplyFinal: false,
    };
    const progress = { text: "progress", idempotencyKey: "sent-progress", sourceReplyFinal: false };
    const previous = copyAttemptDeliveryState(
      makeAttemptResult({
        didSendViaMessagingTool: true,
        didSendDeterministicApprovalPrompt: true,
        sourceReplyDelivered: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSentTexts: Array.from({ length: 200 }, (_, index) => `earlier-${index}`),
        messagingToolSentTargets: [target, target],
        messagingToolSentMediaUrls: ["/tmp/first.png"],
        messagingToolSourceReplyPayloads: [progress],
        successfulCronAdds: 2,
        toolMetas: [{ toolName: "sessions_spawn", asyncStarted: true }],
      }),
    );
    const completed = { text: "done", idempotencyKey: "sent-done", sourceReplyFinal: true };
    const current = makeAttemptResult({
      messagingToolSentTexts: ["current"],
      messagingToolSentTargets: [{ ...target, text: "done", sourceReplyFinal: true }],
      messagingToolSentMediaUrls: ["/tmp/first.png"],
      messagingToolSourceReplyPayloads: [completed],
      successfulCronAdds: 1,
      acceptedSessionSpawns: undefined,
    });
    const result = copyAttemptDeliveryState(current, previous);
    expect(result.messagingToolSentTexts).toHaveLength(200);
    expect(result.messagingToolSentTexts[0]).toBe("earlier-1");
    expect(result.messagingToolSentTexts.at(-1)).toBe("current");
    expect(result).toMatchObject({
      didSendViaMessagingTool: true,
      didSendDeterministicApprovalPrompt: true,
      sourceReplyDelivered: true,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        target,
        target,
        { ...target, text: "done", sourceReplyFinal: true },
      ],
      messagingToolSentMediaUrls: ["/tmp/first.png", "/tmp/first.png"],
      messagingToolSourceReplyPayloads: [progress, completed],
      successfulCronAdds: 3,
      acceptedSessionSpawns: [],
      asyncWorkStarted: true,
    });
    expect(copyAttemptDeliveryState(Object.assign(current, result)).asyncWorkStarted).toBe(true);
  });
});
