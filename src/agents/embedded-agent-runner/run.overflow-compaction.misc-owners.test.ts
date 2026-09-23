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
import { resolveInitialThinkLevel } from "./run/runtime-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

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

  afterEach(() => {
    clearAllRuntimeAuthMaterializations();
  });

  it("publishes an identical prepared API-key success only once", () => {
    const listener = vi.fn();
    const unregister = registerRuntimeAuthMaterializationMutationListener(listener);
    const agentDir = "/tmp/openclaw-auth-success-dedup";
    const input = {
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:work",
        mode: "api-key" as const,
        profileId: "openai:work",
      },
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir,
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none" as const,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
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

  it.each([
    {
      name: "non-profile provenance",
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "env:OPENAI_API_KEY",
        mode: "api-key" as const,
        profileId: "openai:work",
      },
    },
    {
      name: "different profile provenance",
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:other",
        mode: "api-key" as const,
        profileId: "openai:other",
      },
    },
    {
      name: "non-API-key mode",
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:work",
        mode: "token" as const,
        profileId: "openai:work",
      },
    },
  ])("rejects prepared auth with $name", ({ apiKeyInfo }) => {
    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:work",
      profileStore,
      apiKeyInfo,
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: "/tmp/openclaw-auth-success-negative",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none",
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(getPreparedRuntimeAuthMaterializations("/tmp/openclaw-auth-success-negative")).toEqual(
      [],
    );
  });

  it("uses a harness-owned SecretRef fingerprint when the harness resolves it", () => {
    const onSuccessfulAuthBinding = vi.fn();

    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: null,
      attempt: {
        authBindingFingerprint: "resolved-secretref-fingerprint",
      } as EmbeddedRunAttemptResult,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
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
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: null,
      attempt: { runtimeArtifact } as EmbeddedRunAttemptResult,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
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
  it("uses provider policy for a configless MiniMax-M3 run", () => {
    expect(
      resolveInitialThinkLevel({
        config: undefined,
        provider: "minimax",
        modelId: "MiniMax-M3",
        model: { reasoning: true },
      }),
    ).toBe("adaptive");
  });

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
