import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markAuthProfileSuccess } from "../auth-profiles.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../auth-profiles/path-resolve.native.js";
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

it("does not wait for post-run success bookkeeping", () => {
  mockedMarkAuthProfileSuccess.mockReset().mockReturnValueOnce(new Promise<void>(() => {}));
  expect(
    markEmbeddedRunAuthProfileSuccess({
      profileId: "openai:test-profile",
      profileStore: { version: 1, profiles: {} },
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
    }),
  ).toBeUndefined();
  expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledOnce();
});

describe("reportEmbeddedRunSuccessfulAuthBinding", () => {
  beforeEach(() => {
    prepareSharedAuthStoreOwnershipForNative();
  });

  const bindingInput = {
    profileStore: {
      version: 1,
      profiles: {
        "openai:work": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
        },
      },
    },
    profileId: "openai:work",
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
  const agentDir = "/tmp/openclaw-auth-success";
  const preparedBinding = {
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
  afterEach(clearAllRuntimeAuthMaterializations);

  it("publishes an identical prepared API-key success only once", () => {
    const listener = vi.fn();
    const unregister = registerRuntimeAuthMaterializationMutationListener(listener);
    try {
      reportEmbeddedRunSuccessfulAuthBinding(preparedBinding);
      reportEmbeddedRunSuccessfulAuthBinding(preparedBinding);

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
      ...preparedBinding,
      apiKeyInfo: {
        ...preparedBinding.apiKeyInfo,
        source: "env:OPENAI_API_KEY",
      },
    });
    expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([]);
  });

  it.each([
    ["SecretRef", { authBindingFingerprint: "resolved" }, { authFingerprint: "resolved" }],
    [
      "opaque runtime",
      { runtimeArtifact: { id: "runtime", fingerprint: "captured" } },
      {
        runtimeOwnerFingerprint: expect.any(String),
        runtimeArtifactId: "runtime",
        runtimeArtifactFingerprint: "captured",
      },
    ],
  ] as const)("reports exact %s binding provenance", (_name, attempt, expected) => {
    const onSuccessfulAuthBinding = vi.fn();
    reportEmbeddedRunSuccessfulAuthBinding({
      ...bindingInput,
      attempt: { ...bindingInput.attempt, ...attempt },
      onSuccessfulAuthBinding,
    });
    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith({
      authProfileId: "openai:work",
      agentHarnessId: "codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
      ...expected,
    });
  });
});

it("retains bounded ordered delivery facts and source finality across generations", () => {
  const delivered = {
    didSendViaMessagingTool: true,
    didSendDeterministicApprovalPrompt: true,
    sourceReplyDelivered: true,
    didDeliverSourceReplyViaMessageTool: true,
  } as const;
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
      ...delivered,
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
    ...delivered,
    messagingToolSentTargets: [target, target, { ...target, text: "done", sourceReplyFinal: true }],
    messagingToolSentMediaUrls: ["/tmp/first.png", "/tmp/first.png"],
    messagingToolSourceReplyPayloads: [progress, completed],
    successfulCronAdds: 3,
    acceptedSessionSpawns: [],
    asyncWorkStarted: true,
  });
  expect(copyAttemptDeliveryState(Object.assign(current, result)).asyncWorkStarted).toBe(true);
});
