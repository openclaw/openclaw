import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as agentAuth from "openclaw/plugin-sdk/agent-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import * as authBridge from "./auth-bridge.js";
import { CodexSettledTurnContext } from "./settled-turn-context.js";
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
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    settledTurnFinalizationContext: new CodexSettledTurnContext([], selection),
    assistantTexts: [],
    toolMetas: [{ toolName: "message", replaySafe: false }],
    lastAssistant: undefined,
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["update"],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
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

function expectBounded(params: Record<string, unknown>) {
  expect(mocks.runBounded).toHaveBeenCalledWith(expect.objectContaining(params));
}

function mirrorReceipt(assistant: EmbeddedRunAttemptResult["messagesSnapshot"][number]) {
  return {
    assistantMirrorIdentitiesOwned: ["settled-finalizer:run-1"],
    messagesPresent: [
      attachCodexMirrorAttestation(
        assistant,
        fingerprintCodexMirrorSourceMessage(assistant as never),
      ),
    ],
  };
}

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
      const receipt = mirrorReceipt(assistant);
      Object.assign(receipt.messagesPresent[0]!, {
        idempotencyKey: "codex-settled-finalizer:run-1:assistant",
      });
      return receipt;
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

it.each([true, undefined] as const)(
  "preserves private display policy in remote settled finalization (private=%s)",
  async (privateCompletion) => {
    const attempt = createAttempt();
    attempt.privateCompletion = privateCompletion;
    const settledAttempt = createSettledAttempt({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      authProfileId: "openai:captured",
    });
    const options: Parameters<typeof runCodexSettledTurnFinalization>[1] = {
      pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:19400" } },
    };

    const result = await finalize(attempt, settledAttempt, options);

    expectBounded({
      isolation: "configured-transport",
      requireNoExternalCapabilities: true,
      options,
    });
    expect(result).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "codex-settled-finalizer:run-1:assistant",
      usage: boundedResult().usage,
      assistant: {
        provider: "openai",
        model: "synthetic-summary-model",
        content: [{ type: "text", text: "The update was sent successfully." }],
      },
    });
    expect(Reflect.get(result.assistant, "display") === false).toBe(privateCompletion === true);
  },
);

it.each(["agent", "user"] as const)(
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
      readCurrentCredential: null,
    });
    const ordinaryNativeHome = homeScope === "user";
    if (ordinaryNativeHome) {
      attempt.runtimePlan!.auth.forwardedAuthProfileId = "openai:captured";
    }
    const settledAttempt = createSettledAttempt({
      model: "gpt-5.6-luna",
      authProfileId: ordinaryNativeHome ? undefined : "openai:captured",
    });
    const options: Parameters<typeof runCodexSettledTurnFinalization>[1] = {
      pluginConfig: { appServer: { homeScope } },
    };

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
    expectBounded({
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
    });
    expect(mocks.runBounded.mock.calls[0]?.[0]).not.toHaveProperty("profile");
  },
);

it("rejects a missing native provider instead of using outer attribution", async () => {
  const modelProvider = null;
  mocks.runBounded.mockResolvedValue({
    ...boundedResult(),
    nativeSelection: { model: "synthetic-summary-model", modelProvider },
  });
  await expect(finalize()).rejects.toThrow("did not report its native model provider");
  expect(mocks.mirror).not.toHaveBeenCalled();
});

it.each([" NO_REPLY\n", " "])(
  "preserves raw non-visible managed Stop-hook output %j",
  async (text) => {
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
      content: [{ type: "text", text }],
    });
    expect(result.preparedTerminalReply?.terminalReply.disposition).toBe(
      text.trim() ? "silent" : "empty",
    );
    expect(mocks.runBounded).toHaveBeenCalledOnce();
    expect(mocks.mirror).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "native execution",
    true,
    () => [{ id: "command", type: "commandExecution" }],
    "commandExecution",
  ],
  ["unattested hook continuation", undefined, () => [managedHookPrompt], "hookPrompt"],
  ["mismatched prompt echo", undefined, () => [promptEcho("A different prompt.")], "userMessage"],
  [
    "duplicate prompt echo",
    undefined,
    (prompt: string) => [promptEcho(prompt), { ...promptEcho(prompt), id: "echo-2" }],
    "userMessage",
  ],
] as const)(
  "rejects %s before transcript mutation",
  async (_label, managedHooksEnabled, items, rejectedType) => {
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
  await expect(finalize(createAttempt(), settledAttempt)).rejects.toThrow(
    "finalization context is unavailable",
  );
  expect(authBridge.resolveCodexAppServerPreparedAuthHandoff).not.toHaveBeenCalled();
  expect(mocks.runBounded).not.toHaveBeenCalled();
  expect(mocks.mirror).not.toHaveBeenCalled();
  expect(structuredClone(settledAttempt)).toEqual(before);
});

it.each(["before auth", "after auth", "after inference", "at mirror write", "after mirror write"])(
  "rejects cancellation %s without returning a stale final answer",
  async (stage) => {
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
  },
);

it("rejects a stale idempotency hit instead of delivering an unpersisted answer", async () => {
  mocks.mirror.mockImplementation(
    async (params: { messages: EmbeddedRunAttemptResult["messagesSnapshot"] }) => {
      const staleAssistant = {
        ...params.messages[0]!,
        content: [{ type: "text", text: "An older final answer." }],
      } as (typeof params.messages)[number];
      return mirrorReceipt(staleAssistant);
    },
  );

  await expect(finalize()).rejects.toThrow("transcript attestation mismatch");
});

it("does not borrow host credentials to finalize a command-auth turn", async () => {
  const attempt = createAttempt("api-key");
  attempt.runtimePlan!.auth.selectedAuthMode = "native-command";
  await expect(finalize(attempt)).rejects.toThrow("settled-tool fallback");
  expect(mocks.runBounded).not.toHaveBeenCalled();
});
