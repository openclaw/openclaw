import { normalizeUsage, type AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as agentAuth from "openclaw/plugin-sdk/agent-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import * as authBridge from "./auth-bridge.js";
import { CodexSettledTurnContext } from "./settled-turn-context.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";

const mocks = vi.hoisted(() => ({
  runBounded: vi.fn(),
  mirror: vi.fn(),
}));

vi.mock("./bounded-turn.js", () => ({
  runBoundedCodexAppServerTurn: mocks.runBounded,
}));

vi.mock("./transcript-mirror.js", () => ({
  codexTranscriptMirrorRuntime: { mirror: mocks.mirror },
}));

const { runCodexSettledTurnFinalization } = await import("./settled-turn-finalizer.js");

type SettledTurnFinalizationAttemptParams = Parameters<
  NonNullable<AgentHarnessV2["finalizeSettledTurn"]>
>[0]["attempt"];

function createAttempt(
  authRequirement?: "api-key" | "subscription",
): SettledTurnFinalizationAttemptParams {
  return {
    prompt: "Produce the final user-visible answer now.",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/synthetic-finalizer-agent",
    runId: "run-1",
    timeoutMs: 5_000,
    provider: "irrelevant-outer-provider",
    modelId: "irrelevant-outer-model",
    model: {
      id: "irrelevant-outer-model",
      provider: "irrelevant-outer-provider",
      api: "openai-chatgpt-responses",
    } as Model,
    authProfileId: "openai:outer",
    authStorage: {} as never,
    authProfileStore: {
      version: 1,
      profiles: {
        "openai:captured": { type: "api_key", provider: "openai", key: "synthetic-captured-key" },
        "openai:outer": { type: "api_key", provider: "openai", key: "synthetic-wrong-outer-key" },
      },
    },
    runtimePlan: authRequirement
      ? {
          auth: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            forwardedAuthProfileId: "openai:outer",
            modelRoute: {
              provider: "openai",
              modelId: "irrelevant-outer-model",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement,
              requestTransportOverrides: "none",
            },
          },
          observability: { harnessId: "codex" },
        }
      : undefined,
    modelRegistry: {} as never,
    thinkLevel: "low",
  } as SettledTurnFinalizationAttemptParams;
}

function createSettledAttempt(
  selection: ConstructorParameters<typeof CodexSettledTurnContext>[1] = {
    model: "gpt-5.6-luna",
    authProfileId: "openai:captured",
  },
): EmbeddedRunAttemptResult {
  const messagesSnapshot: EmbeddedRunAttemptResult["messagesSnapshot"] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "message", arguments: {} }],
    } as never,
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "message",
      content: [{ type: "text", text: "Message sent." }],
    } as never,
  ];
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot,
    settledTurnFinalizationContext: new CodexSettledTurnContext(
      projectSettledCodexMessages([
        { role: "user", content: "Send the update to Alice." } as never,
        ...messagesSnapshot,
      ]),
      selection,
    ),
    assistantTexts: [],
    toolMetas: [{ toolName: "message", replaySafe: false }],
    lastAssistant: undefined,
    lastToolError: undefined,
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["update"],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: ["/tmp/already-delivered.png"],
    toolAudioAsVoice: true,
    hasToolMediaBlockReply: true,
    successfulCronAdds: 1,
    cloudCodeAssistFormatError: false,
    attemptUsage: { input: 100, output: 20, total: 120 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
  };
}

function boundedResult() {
  return {
    text: "The update was sent successfully.",
    items: [],
    submittedInput: [{ type: "text", text: createAttempt().prompt, text_elements: [] }],
    model: "synthetic-catalog-id",
    nativeSelection: { model: "synthetic-summary-model", modelProvider: "openai" },
    usage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, reasoningTokens: 3, total: 12 },
  };
}

const managedHookPrompt = {
  id: "hook",
  type: "hookPrompt",
  fragments: [{ text: "Revise the answer.", hookRunId: "managed-stop-1" }],
};

function promptEcho(text: string) {
  return {
    id: "prompt-echo",
    type: "userMessage",
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function managedHookItems(text: string) {
  return [
    { id: "draft", type: "agentMessage", text: "An earlier draft." },
    managedHookPrompt,
    { id: "answer", type: "agentMessage", text },
  ];
}

function finalize(
  attempt = createAttempt(),
  settledAttempt = createSettledAttempt(),
  options: Parameters<typeof runCodexSettledTurnFinalization>[1] = {},
) {
  return runCodexSettledTurnFinalization({ attempt, settledAttempt }, options);
}

describe("runCodexSettledTurnFinalization", () => {
  beforeEach(() => {
    vi.spyOn(authBridge, "resolveCodexAppServerPreparedAuthHandoff");
    mocks.runBounded.mockReset().mockResolvedValue(boundedResult());
    mocks.mirror.mockReset();
    mocks.mirror.mockImplementation(
      async (params: {
        messages: EmbeddedRunAttemptResult["messagesSnapshot"];
        assertCurrent?: () => void;
      }) => {
        params.assertCurrent?.();
        const assistant = params.messages[0]!;
        return {
          assistantMirrorIdentitiesOwned: ["settled-finalizer:run-1"],
          messagesPresent: [
            attachCodexMirrorAttestation(
              Object.assign({}, assistant, {
                idempotencyKey: "codex-settled-finalizer:run-1:assistant",
              }),
              fingerprintCodexMirrorSourceMessage(assistant as never),
            ),
          ],
        };
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds tool-result failure status into mirror attestations", () => {
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "message",
      content: [{ type: "text", text: "Message sent." }],
    };

    expect(fingerprintCodexMirrorSourceMessage(toolResult as never)).not.toBe(
      fingerprintCodexMirrorSourceMessage({ ...toolResult, isError: true } as never),
    );
  });

  it("uses captured model/profile and returned native attribution", async () => {
    const modelProvider = "openai";
    const attempt = createAttempt();
    attempt.prepareAssistantTranscriptMessage = (message) => message;
    const settledAttempt = createSettledAttempt({
      model: "gpt-5.6-luna",
      modelProvider,
      authProfileId: "openai:captured",
    });
    const settledBefore = structuredClone(settledAttempt);
    const result = await finalize(attempt, settledAttempt, { pluginConfig: {} });

    expect(authBridge.resolveCodexAppServerPreparedAuthHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        homeScope: "agent",
        authProfileId: "openai:captured",
        authProfileStore: attempt.authProfileStore,
      }),
    );
    expect(mocks.runBounded).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { mode: "required", id: "gpt-5.6-luna" },
        modelProvider,
        profile: "openai:captured",
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
        allowEmptyText: true,
        historyItems: [
          expect.objectContaining({ type: "message", role: "user" }),
          expect.objectContaining({ type: "function_call", call_id: "call-1" }),
          expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
        ],
        input: [{ type: "text", text: attempt.prompt, text_elements: [] }],
      }),
    );
    expect(mocks.mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        idempotencyScope: "codex-settled-finalizer:run-1",
        skipBeforeMessageWriteHooks: true,
        prepareAssistantTranscriptMessage: attempt.prepareAssistantTranscriptMessage,
        messages: [
          expect.objectContaining({
            role: "assistant",
            provider: "openai",
            model: "synthetic-summary-model",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "codex-settled-finalizer:run-1:assistant",
      usage: boundedResult().usage,
      assistant: {
        role: "assistant",
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "synthetic-summary-model",
        content: [{ type: "text", text: "The update was sent successfully." }],
      },
    });
    expect(normalizeUsage(result.assistant.usage)?.reasoningTokens).toBe(3);
    expect(structuredClone(settledAttempt)).toEqual(settledBefore);
  });

  it("uses the prepared API key without resolving the outer profile", async () => {
    const attempt = createAttempt("api-key");
    attempt.resolvedApiKey = "synthetic-resolved-api-key";
    attempt.model = { ...attempt.model, api: "openai-responses" };
    const resolveProfile = vi.spyOn(agentAuth, "resolveApiKeyForProfile");

    const result = await finalize(attempt);

    expect(mocks.runBounded).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "synthetic-resolved-api-key" },
        authRequirement: "api-key",
        authProfileStore: attempt.authProfileStore,
      }),
    );
    expect(mocks.runBounded.mock.calls[0]?.[0]).not.toHaveProperty("profile");
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(result.assistant).toMatchObject({
      api: "openai-responses",
      provider: "openai",
      model: "synthetic-summary-model",
    });
  });

  it("uses configured transport for remote settled finalization", async () => {
    const attempt = createAttempt();
    const settledAttempt = createSettledAttempt({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      authProfileId: "openai:captured",
    });
    const options = {
      pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:19400" } },
    };

    await finalize(attempt, settledAttempt, options);

    expect(mocks.runBounded).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "configured-transport",
        requireNoExternalCapabilities: true,
        options,
      }),
    );
  });

  it.each(["agent", "user"])(
    "uses the selected scoped subscription for a bounded side turn (ordinary home: %s)",
    async (homeScope) => {
      const attempt = createAttempt("subscription");
      const token = [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
          }),
        ).toString("base64url"),
        "synthetic-signature",
      ].join(".");
      attempt.authProfileStore.profiles["openai:captured"] = {
        type: "token",
        provider: "openai",
        token,
      };
      const resolveProfile = vi.spyOn(agentAuth, "resolveApiKeyForProfile").mockResolvedValue({
        apiKey: token,
        provider: "openai",
        profileId: "openai:captured",
        profileType: "token",
      });
      const ordinaryNativeHome = homeScope === "user";
      if (ordinaryNativeHome) {
        attempt.runtimePlan!.auth.forwardedAuthProfileId = "openai:captured";
      }
      const settledAttempt = createSettledAttempt({
        model: "gpt-5.6-luna",
        authProfileId: ordinaryNativeHome ? undefined : "openai:captured",
      });
      const options = { pluginConfig: { appServer: { homeScope } } };

      await finalize(attempt, settledAttempt, options);

      expect(resolveProfile).toHaveBeenCalledExactlyOnceWith({
        store: attempt.authProfileStore,
        profileId: "openai:captured",
        agentDir: attempt.agentDir,
      });
      expect(authBridge.resolveCodexAppServerPreparedAuthHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          homeScope: "agent",
          authProfileId: "openai:captured",
          authProfileStore: attempt.authProfileStore,
          authRequirement: "subscription",
        }),
      );
      expect(mocks.runBounded).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "private-stdio",
          options,
          authRequirement: "subscription",
          preparedAuth: {
            kind: "profile",
            profileId: "openai:captured",
            store: attempt.authProfileStore,
            snapshot: expect.objectContaining({
              loginParams: {
                type: "chatgptAuthTokens",
                accessToken: token,
                chatgptAccountId: "synthetic-account",
                chatgptPlanType: null,
              },
            }),
          },
        }),
      );
      expect(mocks.runBounded.mock.calls[0]?.[0]).not.toHaveProperty("profile");
    },
  );

  it("does not mutate the transcript when the bounded turn is interrupted", async () => {
    mocks.runBounded.mockRejectedValue(
      new Error("codex app-server settled-turn finalization turn ended with status interrupted"),
    );

    await expect(finalize()).rejects.toThrow("turn ended with status interrupted");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("rejects a missing native provider instead of using outer attribution", async () => {
    const modelProvider = null;
    mocks.runBounded.mockResolvedValue({
      ...boundedResult(),
      nativeSelection: { model: "synthetic-summary-model", modelProvider },
    });
    await expect(finalize()).rejects.toThrow("did not report its native model provider");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it.each([" NO_REPLY\n", " "])("preserves silent managed Stop-hook output %j", async (text) => {
    mocks.runBounded.mockResolvedValue({
      ...boundedResult(),
      text,
      managedHooksEnabled: true,
      items: managedHookItems(text),
    });
    const result = await finalize();
    expect(result.assistant).toMatchObject({
      provider: "openai",
      model: "synthetic-summary-model",
      content: [{ type: "text", text: text.trim() }],
    });
    expect(mocks.runBounded).toHaveBeenCalledOnce();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("accepts the exact current-turn prompt echo once", async () => {
    const attempt = createAttempt();
    mocks.runBounded.mockResolvedValue({
      ...boundedResult(),
      items: [
        promptEcho(attempt.prompt),
        { id: "answer", type: "agentMessage", text: "The update was sent successfully." },
      ],
    });

    await expect(finalize(attempt)).resolves.toMatchObject({ assistantTranscriptOwned: true });
    expect(mocks.mirror).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "native execution",
      managedHooksEnabled: true,
      items: () => [{ id: "command", type: "commandExecution" }],
      rejectedType: "commandExecution",
    },
    {
      label: "unattested hook continuation",
      managedHooksEnabled: undefined,
      items: () => [managedHookPrompt],
      rejectedType: "hookPrompt",
    },
    {
      label: "mismatched prompt echo",
      managedHooksEnabled: undefined,
      items: () => [promptEcho("A different prompt.")],
      rejectedType: "userMessage",
    },
    {
      label: "duplicate prompt echo",
      managedHooksEnabled: undefined,
      items: (prompt: string) => [promptEcho(prompt), { ...promptEcho(prompt), id: "echo-2" }],
      rejectedType: "userMessage",
    },
  ])(
    "rejects $label before transcript mutation",
    async ({ items, managedHooksEnabled, rejectedType }) => {
      const attempt = createAttempt();
      mocks.runBounded.mockResolvedValue({
        ...boundedResult(),
        managedHooksEnabled,
        items: items(attempt.prompt),
      });
      await expect(finalize(attempt)).rejects.toThrow(`unexpected native item: ${rejectedType}`);
      expect(mocks.mirror).not.toHaveBeenCalled();
    },
  );

  it("rejects forged context before host auth or an isolated client can be used", async () => {
    const settledAttempt = createSettledAttempt();
    settledAttempt.settledTurnFinalizationContext = { source: "harness", data: [] };
    const before = structuredClone(settledAttempt);
    const clientFactory = vi.fn();
    await expect(finalize(createAttempt(), settledAttempt, { clientFactory })).rejects.toThrow(
      "finalization context is unavailable",
    );
    expect(authBridge.resolveCodexAppServerPreparedAuthHandoff).not.toHaveBeenCalled();
    expect(mocks.runBounded).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(structuredClone(settledAttempt)).toEqual(before);
  });

  it.each([
    "before auth",
    "after auth",
    "after inference",
    "at mirror write",
    "after mirror write",
  ])("rejects cancellation %s without returning a stale final answer", async (stage) => {
    const caller = new AbortController();
    const attempt = { ...createAttempt(), abortSignal: caller.signal };
    const reason = new Error("finalizer cancelled");
    if (stage === "before auth") {
      caller.abort(reason);
    } else if (stage === "after auth") {
      vi.mocked(authBridge.resolveCodexAppServerPreparedAuthHandoff).mockImplementationOnce(
        async () => {
          caller.abort(reason);
          return { nativeAuthProfile: false, authProfileId: "openai:captured" };
        },
      );
    } else if (stage === "after inference") {
      mocks.runBounded.mockImplementationOnce(async () => {
        caller.abort(reason);
        return boundedResult();
      });
    } else {
      const mirror = mocks.mirror.getMockImplementation()!;
      mocks.mirror.mockImplementationOnce(async (params) => {
        if (stage === "at mirror write") {
          caller.abort(reason);
        }
        const result = await mirror(params);
        caller.abort(reason);
        return result;
      });
    }

    await expect(finalize(attempt)).rejects.toBe(reason);
    if (stage === "before auth") {
      expect(authBridge.resolveCodexAppServerPreparedAuthHandoff).not.toHaveBeenCalled();
    }
    if (stage === "before auth" || stage === "after auth") {
      expect(mocks.runBounded).not.toHaveBeenCalled();
    }
    expect(mocks.mirror).toHaveBeenCalledTimes(stage.includes("mirror") ? 1 : 0);
  });

  it("rejects a stale idempotency hit instead of delivering an unpersisted answer", async () => {
    mocks.mirror.mockImplementation(
      async (params: { messages: EmbeddedRunAttemptResult["messagesSnapshot"] }) => {
        const staleAssistant = {
          ...params.messages[0]!,
          content: [{ type: "text", text: "An older final answer." }],
        } as (typeof params.messages)[number];
        return {
          assistantMirrorIdentitiesOwned: ["settled-finalizer:run-1"],
          messagesPresent: [
            attachCodexMirrorAttestation(
              staleAssistant,
              fingerprintCodexMirrorSourceMessage(staleAssistant as never),
            ),
          ],
        };
      },
    );

    await expect(finalize()).rejects.toThrow("transcript attestation mismatch");
  });
});
