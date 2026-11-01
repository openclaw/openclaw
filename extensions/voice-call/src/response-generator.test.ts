import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { normalizeVoiceCallConfig } from "./config.js";
import { generateVoiceResponse } from "./response-generator.js";

type AgentRuntime = OpenClawPluginApi["runtime"]["agent"];
type TestSessionEntry = NonNullable<
  Awaited<ReturnType<AgentRuntime["session"]["getSessionEntryAsync"]>>
>;
type EmbeddedAgentArgs = Parameters<AgentRuntime["runEmbeddedAgent"]>[0];
type ReplyPayload = Parameters<NonNullable<EmbeddedAgentArgs["onBlockReply"]>>[0];
type VoiceResponseParams = Parameters<typeof generateVoiceResponse>[0];
const defaultSessionKey = "agent:main:voice:15550001111";
const voiceConfig = (overrides: Partial<ReturnType<typeof normalizeVoiceCallConfig>> = {}) =>
  normalizeVoiceCallConfig({ responseTimeoutMs: 5000, ...overrides });
const sessionEntry = (overrides: Partial<TestSessionEntry> = {}): TestSessionEntry => ({
  sessionId: "existing-session",
  updatedAt: 100,
  ...overrides,
});
const spoken = (text: string): ReplyPayload => ({ text: JSON.stringify({ spoken: text }) });
const agentResult = (text?: string) => ({
  payloads: text ? [spoken(text)] : [],
  meta: { durationMs: 20_000, aborted: false },
});

function createAgentRuntime(
  payloads: ReplyPayload[],
  options?: { blockReplyPayloads?: ReplyPayload[] },
) {
  const sessionStore: Record<string, TestSessionEntry> = {};
  const prepareSessionEntryPatch = vi.fn(
    async (params: Parameters<AgentRuntime["session"]["prepareSessionEntryPatch"]>[0]) => {
      const stored = sessionStore[params.sessionKey];
      const existing = stored ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await params.prepare({ ...existing }, { existingEntry: stored });
      if (!patch) {
        return existing;
      }
      const next = params.replaceEntry ? (patch as TestSessionEntry) : { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  const runEmbeddedAgent = vi.fn(async (args: EmbeddedAgentArgs) => {
    for (const payload of options?.blockReplyPayloads ?? []) {
      await args.onBlockReply?.(payload, { assistantMessageIndex: 0 });
    }
    await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
    return {
      payloads,
      meta: { durationMs: 12, aborted: false },
    };
  });
  const runWithWorkAdmission = vi.fn(
    async (
      _params: { storePath: string; sessionKey: string },
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => await run(new AbortController().signal),
  );
  const runtime = {
    defaults: {
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
    },
    resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/openclaw/agents/${agentId}`,
    resolveAgentWorkspaceDir: (_cfg: OpenClawConfig, agentId: string) =>
      `/tmp/openclaw/workspace/${agentId}`,
    resolveAgentIdentity: (_cfg: OpenClawConfig, agentId: string) => ({
      name: `${agentId} tester`,
    }),
    resolveThinkingDefault: () => "off",
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => {},
    runEmbeddedAgent,
    session: {
      resolveStorePath: (_store: string | undefined, params: { agentId?: string }) =>
        `/tmp/openclaw/${params.agentId ?? "main"}/sessions.json`,
      getSessionEntryAsync: async (params: { sessionKey: string }) =>
        sessionStore[params.sessionKey],
      prepareSessionEntryPatch,
      runWithWorkAdmission,
    },
  } as unknown as AgentRuntime;

  return {
    runtime,
    runEmbeddedAgent,
    runWithWorkAdmission,
    prepareSessionEntryPatch,
    sessionStore,
  };
}

function requireEmbeddedAgentArgs(
  runEmbeddedAgent: ReturnType<typeof createAgentRuntime>["runEmbeddedAgent"],
) {
  const [args] = expectDefined(
    runEmbeddedAgent.mock.calls.at(0),
    "voice response generator embedded agent invocation",
  );
  if (!args.extraSystemPrompt) {
    throw new Error("voice response generator did not pass the spoken-output contract prompt");
  }
  return args;
}

/** The harness core config mirrors the fake runtime's model defaults through the configured path. */
const coreConfigWithDefaultModel = {
  agents: { defaults: { model: { primary: "together/Qwen/Qwen2.5-7B-Instruct-Turbo" } } },
} as OpenClawConfig;

async function runGenerateVoiceResponse(
  payloads: ReplyPayload[],
  overrides: Partial<VoiceResponseParams> & { runtime?: AgentRuntime } = {},
) {
  const { runtime, ...params } = overrides;
  const userMessage = params.userMessage ?? "hello there";
  const result = await generateVoiceResponse({
    voiceConfig: voiceConfig(),
    coreConfig: coreConfigWithDefaultModel,
    agentRuntime: runtime ?? createAgentRuntime(payloads).runtime,
    callId: "call-123",
    agentId: "main",
    from: "+15550001111",
    senderIsOwner: undefined,
    transcript: [{ speaker: "user", text: userMessage }],
    userMessage,
    ...params,
  });

  return { result };
}

async function runStreamingScenario(
  deliver: (args: EmbeddedAgentArgs) => Promise<void>,
  finalText: string,
) {
  const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
  runEmbeddedAgent.mockImplementationOnce(async (args) => {
    await deliver(args);
    return agentResult(finalText);
  });
  const onEarlyText = vi.fn(async () => true);
  const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });
  return { result, onEarlyText };
}

async function generated(params: Partial<VoiceResponseParams> = {}, entry?: TestSessionEntry) {
  const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
    spoken("Safe response."),
  ]);
  if (entry) {
    sessionStore[params.sessionKey ?? defaultSessionKey] = entry;
  }
  const { result } = await runGenerateVoiceResponse([], { runtime, ...params });
  expect(result.text).toBe("Safe response.");
  return { args: requireEmbeddedAgentArgs(runEmbeddedAgent), sessionStore };
}

describe("generateVoiceResponse", () => {
  it("keeps bounded audible opening context at external-user priority", async () => {
    const currentCallerSpeech = "My confirmation number is ABC-123";
    const { args } = await generated({
      transcript: [
        { speaker: "bot", text: "Welcome. What is the confirmation number?" },
        { speaker: "user", text: currentCallerSpeech },
      ],
      userMessage: currentCallerSpeech,
      senderIsOwner: false,
    });

    expect(args.senderIsOwner).toBe(false);
    expect(args.prompt).toContain("[Audible call-opening context]");
    expect(args.prompt).toContain("Assistant: Welcome. What is the confirmation number?");
    expect(args.prompt).toContain(`Current caller message:\n${currentCallerSpeech}`);
    expect(args.prompt).not.toContain(`Caller: ${currentCallerSpeech}`);
    expect(args.transcriptPrompt).toBe(currentCallerSpeech);
    expect(args.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "voice",
    });
    expect(args.extraSystemPrompt).not.toContain(currentCallerSpeech);
    expect(args.extraSystemPrompt).toContain("helpful voice assistant on a phone call");
    expect(args.extraSystemPrompt).toContain("untrusted conversation data");
    expect(args.extraSystemPrompt).toContain("Return only valid JSON in this exact shape");
  });

  it("does not replay cumulative call history after the first caller turn", async () => {
    const currentCallerSpeech = "What did you just say?";
    const { args } = await generated({
      transcript: [
        { speaker: "bot", text: "Welcome to the service." },
        { speaker: "user", text: "Please check order ABC." },
        { speaker: "bot", text: "Order ABC is ready." },
        { speaker: "user", text: currentCallerSpeech },
      ],
      userMessage: currentCallerSpeech,
    });

    expect(args.prompt).toBe(currentCallerSpeech);
    expect(args.transcriptPrompt).toBe(currentCallerSpeech);
  });

  it("caps oversized audible opening context without splitting UTF-16", async () => {
    const currentCallerSpeech = "I am ready.";
    const oversizedGreeting = "🚀x".repeat(3_000);
    const { args } = await generated({
      transcript: [
        { speaker: "bot", text: oversizedGreeting },
        { speaker: "user", text: currentCallerSpeech },
      ],
      userMessage: currentCallerSpeech,
    });

    expect(args.prompt.length).toBeLessThanOrEqual(2_100 + currentCallerSpeech.length);
    expect(args.prompt).toContain(" [truncated]");
    expect(args.prompt).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    expect(args.transcriptPrompt).toBe(currentCallerSpeech);
  });

  it("suppresses reasoning payloads and reads structured spoken output", async () => {
    const { runtime, runEmbeddedAgent, runWithWorkAdmission } = createAgentRuntime([
      { text: "Reasoning: hidden", isReasoning: true },
      { text: '{"spoken":"Hello from JSON."}' },
    ]);
    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result.text).toBe("Hello from JSON.");
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.extraSystemPrompt).toContain('{"spoken":"..."}');
    expect(args).toMatchObject({
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
      abortSignal: expect.any(AbortSignal),
    });
    expect(args.senderIsOwner).toBeUndefined();
    expect(runWithWorkAdmission).toHaveBeenCalledWith(
      {
        storePath: "/tmp/openclaw/main/sessions.json",
        sessionKey: "agent:main:voice:15550001111",
      },
      expect.any(Function),
    );
  });

  it.each([
    { payloads: [] },
    { payloads: [{ text: "provider failed: synthetic-private-detail", isError: true }] },
    { payloads: [{ text: "```js\nconst x = 1;\n```" }] },
  ])("reports unusable output as a failed generation (%j)", async ({ payloads }) => {
    const { result } = await runGenerateVoiceResponse(payloads);
    expect(result.text).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("synthetic-private-detail");
  });

  it("returns the lifecycle rejection without starting the embedded agent", async () => {
    const { runtime, runEmbeddedAgent, runWithWorkAdmission } = createAgentRuntime([]);
    runWithWorkAdmission.mockRejectedValueOnce(
      new Error('Session "agent:main:voice:15550001111" is archived.'),
    );

    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result).toEqual({
      text: null,
      deliveredEarly: false,
      error: 'Error: Session "agent:main:voice:15550001111" is archived.',
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("delivers a completed reply block before the embedded run settles", async () => {
    const { promise: runFinished, resolve: finishRun } =
      createDeferred<ReturnType<typeof agentResult>>();
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      await args.onBlockReply?.({ text: '{"spoken":"Already ready."}' });
      expect(await args.resolveReplyDelivery?.()).toBe("missing");
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      expect(await args.resolveReplyDelivery?.()).toBe("pending");
      expect(await args.resolveReplyDelivery?.(1)).toBe("missing");
      return await runFinished;
    });
    const { promise: earlyDeliveryStarted, resolve: reportEarlyDelivery } = createDeferred<void>();
    const onEarlyText = vi.fn(async () => {
      reportEarlyDelivery();
      return true;
    });

    const response = runGenerateVoiceResponse([], { runtime, onEarlyText });
    await earlyDeliveryStarted;

    expect(onEarlyText).toHaveBeenCalledWith("Already ready.");
    finishRun(agentResult());
    await expect(response).resolves.toEqual({
      result: { text: "Already ready.", deliveredEarly: true },
    });
  });

  it("awaits in-flight early delivery before exposing the fallback decision", async () => {
    const { runtime } = createAgentRuntime([], {
      blockReplyPayloads: [{ text: '{"spoken":"No duplicate."}' }],
    });
    const { promise: deliveryFinished, resolve: finishDelivery } = createDeferred<boolean>();
    const onEarlyText = vi.fn(async () => await deliveryFinished);
    let responseSettled = false;

    const response = runGenerateVoiceResponse([], { runtime, onEarlyText }).finally(() => {
      responseSettled = true;
    });
    await vi.waitFor(() => expect(onEarlyText).toHaveBeenCalledOnce());
    expect(responseSettled).toBe(false);

    finishDelivery(true);
    await expect(response).resolves.toEqual({
      result: { text: "No duplicate.", deliveredEarly: true },
    });
  });

  it.each(["before", "after"])(
    "discards pre-tool narration arriving %s the boundary",
    async (order) => {
      const answer = "The result is ready.";
      const { result, onEarlyText } = await runStreamingScenario(async (args) => {
        const narrate = () =>
          args.onBlockReply?.(spoken("I will check."), { assistantMessageIndex: 0 });
        if (order === "before") {
          await narrate();
        }
        await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
        if (order === "after") {
          await narrate();
        }
        await args.onBlockReply?.(spoken(answer), { assistantMessageIndex: 1 });
        await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      }, answer);
      expect(onEarlyText).toHaveBeenCalledWith(answer);
      expect(result).toEqual({ text: answer, deliveredEarly: true });
    },
  );

  it("keeps final delivery when a post-tool payload has no boundary metadata", async () => {
    const { result, onEarlyText } = await runStreamingScenario(async (args) => {
      await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
      await args.onBlockReply?.({ text: '{"spoken":"Unclassified response."}' });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
    }, "Complete fallback response.");

    expect(onEarlyText).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "Complete fallback response.", deliveredEarly: false });
  });

  it("resets a rejected attempt tool boundary before the accepted retry", async () => {
    const { result, onEarlyText } = await runStreamingScenario(async (args) => {
      await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
      await args.onBlockReply?.(spoken("Rejected tool response."), { assistantMessageIndex: 1 });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
      await args.onBlockReply?.(spoken("Accepted retry response."), { assistantMessageIndex: 0 });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
    }, "Accepted retry response.");

    expect(onEarlyText).toHaveBeenCalledWith("Accepted retry response.");
    expect(result).toEqual({ text: "Accepted retry response.", deliveredEarly: true });
  });

  it.each([
    ['```json\n{"spoken":"Fenced JSON works."}\n```', "Fenced JSON works."],
    ['prefix "spoken": "Hello\\nthere" tail', "Hello there"],
    ['prefix "spoken": "" tail', null],
    ['prefix "spoken": "bad\\q" tail', 'prefix "spoken": "bad\\q" tail'],
    ['{"spoken":""}', null],
    [
      "The user responded with short text. I should keep the response concise.\n\nSounds good.",
      "Sounds good.",
    ],
  ] as const)(
    "recovers spoken JSON while preserving plain-text fallback: %j",
    async (text, expected) => {
      const { result } = await runGenerateVoiceResponse([{ text }]);

      expect(result.text).toBe(expected);
      expect(result.error).toBeUndefined();
    },
  );

  it("inherits the call agent model ahead of the global default", async () => {
    const { args } = await generated({
      coreConfig: {
        agents: {
          entries: { main: { model: "anthropic/claude-opus-5-5" } },
          defaults: { model: { primary: "openai/gpt-5.4" } },
        },
      },
    });
    expect(args).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("pins the voice session to responseModel before running the embedded agent", async () => {
    const { args, sessionStore } = await generated(
      { voiceConfig: voiceConfig({ responseModel: "openai/gpt-4.1-nano" }) },
      sessionEntry({
        model: "old-model",
        modelProvider: "old-provider",
        contextTokens: 123,
        authProfileOverride: "old-auth-profile",
      }),
    );
    const pinnedSessionEntry = sessionStore[defaultSessionKey];
    expect(pinnedSessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4.1-nano",
      modelOverrideSource: "auto",
    });
    for (const key of ["model", "modelProvider", "contextTokens", "authProfileOverride"] as const) {
      expect(pinnedSessionEntry?.[key]).toBeUndefined();
    }
    expect(args).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-nano",
      sessionKey: defaultSessionKey,
    });
  });

  it("rejects responseModel for a model-locked session without running the embedded agent", async () => {
    const { runtime, runEmbeddedAgent, prepareSessionEntryPatch, sessionStore } =
      createAgentRuntime([]);
    const lockedEntry = sessionEntry({
      sessionId: "locked-session",
      model: "gpt-5.5",
      modelProvider: "openai",
      modelSelectionLocked: true,
    });
    sessionStore[defaultSessionKey] = { ...lockedEntry };

    const { result } = await runGenerateVoiceResponse([], {
      voiceConfig: voiceConfig({ responseModel: "openai/gpt-4.1-nano" }),
      runtime,
    });

    expect(result).toEqual({
      text: null,
      deliveredEarly: false,
      error: "Model selection is locked for this session.",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(prepareSessionEntryPatch).not.toHaveBeenCalled();
    expect(sessionStore[defaultSessionKey]).toEqual(lockedEntry);
    expect(sessionStore[defaultSessionKey]?.modelOverride).toBeUndefined();
  });

  it("propagates the lock for a same-agent supervised Codex session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:019f-codex-thread";
    const { args } = await generated(
      { sessionKey, userMessage: "continue" },
      sessionEntry({
        sessionId: "catalog-adopted-session",
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            supervision: { sourceThreadId: "019f-codex-thread", modelLocked: true },
          },
        },
      }),
    );
    expect(args).toMatchObject({
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      sessionKey,
    });
  });

  it.each([
    {
      name: "unlocked observation",
      entry: { agentHarnessId: "codex" },
    },
    {
      name: "plugin-owned runtime request",
      entry: {
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
        pluginOwnerId: "voice-call",
      },
    },
  ])("does not turn $name into a native voice pin", async ({ entry }) => {
    const { args } = await generated({}, sessionEntry(entry));
    expect(args).toMatchObject({
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: undefined,
      modelSelectionLocked: entry.modelSelectionLocked === true,
    });
  });

  it("keeps wrapped foreign Matrix identities stable across restore", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      spoken("Matrix context."),
    ]);
    const canonical = "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org";
    const generate = (sessionKey: string) =>
      runGenerateVoiceResponse([], {
        voiceConfig: voiceConfig({ agentId: "voice" }),
        runtime,
        agentId: "voice",
        sessionKey,
        transcript: [],
      });

    await generate("agent:other:matrix:channel:!RoomAbC:example.org");
    await generate(canonical);
    await generate("agent:other:matrix:channel:!Roomabc:example.org");

    expect(sessionStore[canonical]?.sessionId).toBeTypeOf("string");
    expect(
      sessionStore["agent:voice:agent:other:matrix:channel:!Roomabc:example.org"]?.sessionId,
    ).toBeTypeOf("string");
    expect(Object.keys(sessionStore)).toHaveLength(2);
    const sessionKeys = runEmbeddedAgent.mock.calls.map(([args]) => args.sessionKey);
    expect(sessionKeys).toEqual([
      canonical,
      canonical,
      "agent:voice:agent:other:matrix:channel:!Roomabc:example.org",
    ]);
  });

  it("uses the configured core main key for restored call aliases", async () => {
    const { args, sessionStore } = await generated({
      voiceConfig: voiceConfig({ agentId: "voice" }),
      coreConfig: { session: { mainKey: "work" } },
      agentId: "voice",
      sessionKey: "agent:voice:main",
      transcript: [],
    });

    expect(sessionStore["agent:voice:work"]?.sessionId).toBeTypeOf("string");
    expect(args.sessionKey).toBe("agent:voice:work");
  });

  it("rejects an empty recorded owner before session work", async () => {
    const { runtime, runEmbeddedAgent, runWithWorkAdmission, sessionStore } = createAgentRuntime(
      [],
    );

    await expect(
      runGenerateVoiceResponse([], {
        voiceConfig: normalizeVoiceCallConfig({ agentId: "voice" }),
        runtime,
        callId: "call-unowned",
        agentId: " ",
        sessionKey: "agent:support:voice:15550001111",
        transcript: [],
      }),
    ).rejects.toThrow("Voice Call has no recorded agent owner");

    expect(runWithWorkAdmission).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(sessionStore).toEqual({});
  });

  it.each([
    { policy: "finite allowlist", tools: { allow: ["web_search"] } },
    { policy: "empty configured allowlist", tools: { allow: [] } },
    { policy: "allowlist with a deny", tools: { allow: ["web_search", "read"], deny: ["read"] } },
  ])("keeps the routed agent's $policy in conversation config across turns", async ({ tools }) => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([spoken("No tools needed.")]);
    const coreConfig = { agents: { entries: { voice: { tools } } } } satisfies OpenClawConfig;

    const params = {
      voiceConfig: voiceConfig({ agentId: "main", responseModel: "ollama/qwen2.5:1.5b" }),
      coreConfig,
      runtime,
      agentId: "voice",
      transcript: [],
    } satisfies NonNullable<Parameters<typeof runGenerateVoiceResponse>[1]>;

    for (const userMessage of ["hello there", "continue"]) {
      const { result } = await runGenerateVoiceResponse([], { ...params, userMessage });
      expect(result.text).toBe("No tools needed.");
    }

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    for (const [args] of runEmbeddedAgent.mock.calls) {
      expect(args.agentId).toBe("voice");
      expect(args.config).toBe(coreConfig);
      // Runtime toolsAllow has turn lifetime, even when copied from persistent config.
      expect(args.toolsAllow).toBeUndefined();
      expect(args.sessionKey).toBe("agent:voice:voice:15550001111");
    }
  });
});
