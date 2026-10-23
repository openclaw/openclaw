import { zstdDecompressSync } from "node:zlib";
import { createApiRegistry } from "@openclaw/ai";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { Context, Model, StreamFn } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../../packages/ai/src/host.js";
import { streamSimpleOpenAICodexResponses } from "../../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import type { OpenAIResponsesOptions } from "../../../../packages/ai/src/transports/openai-responses-contracts.js";
import { ensureCustomApiRegistered } from "../../custom-api-registry.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  agentSessionDeferThresholdCompaction,
  type AgentSessionEvent,
} from "../../sessions/agent-session-types.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { log } from "../logger.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import {
  createChatGPTV2CompactionBoundary,
  isChatGPTV2CompactionEligible,
} from "./chatgpt-v2-compaction.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();
const initialHost = getAiTransportHost();
const model = {
  id: "test-v2",
  name: "Test ChatGPT",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 512,
} satisfies Model;
const terminal = {
  type: "response.completed",
  response: {
    id: "resp_fixture",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 30,
      output_tokens: 5,
      total_tokens: 35,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  },
};
const compactEvents = (index: number) => [
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "compaction", encrypted_content: "opaque" + index },
  },
  terminal,
];
const outputEvents = (item: Record<string, unknown>) => [
  { type: "response.output_item.added", output_index: 0, item },
  { type: "response.output_item.done", output_index: 0, item },
  terminal,
];
const toolEvents = () => {
  const item = {
    type: "function_call",
    id: "fc_fixture",
    call_id: "call_fixture",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  };
  return outputEvents(item);
};
const textEvents = () => {
  const item = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };
  return outputEvents(item);
};
type Body = {
  input: Array<Record<string, unknown>>;
  tools?: unknown;
  instructions?: string;
  hook_marker?: string;
};
let requests: Body[];
let respond: (body: Body) => unknown[];
beforeEach(() => {
  requests = [];
  let compactions = 0;
  respond = (body) =>
    body.input.at(-1)?.type === "compaction_trigger" ? compactEvents(++compactions) : textEvents();
  const captureFetch: typeof fetch = async (_input, init) => {
    const raw = Buffer.from(await new Response(init?.body).arrayBuffer());
    const body = JSON.parse(
      (new Headers(init?.headers).get("content-encoding") === "zstd"
        ? zstdDecompressSync(raw)
        : raw
      ).toString(),
    ) as Body;
    requests.push(body);
    return new Response(
      respond(body)
        .map((event) => "data: " + JSON.stringify(event) + "\n\n")
        .join(""),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  };
  configureAiTransportHost({ buildModelFetch: () => captureFetch });
  vi.stubGlobal("fetch", captureFetch);
});
afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.unstubAllGlobals();
});

const highUsageCompletion = {
  ...terminal,
  response: {
    ...terminal.response,
    usage: { ...terminal.response.usage, input_tokens: 465_668, total_tokens: 465_674 },
  },
};
function requestAt(index: number) {
  const request = requests[index];
  if (!request) {
    throw new Error(`Missing request ${index}`);
  }
  return request;
}
const persistedMessages = (manager: SessionManager) => manager.buildSessionContext().messages;
const hasReplay = (manager: SessionManager) =>
  persistedMessages(manager).some(
    (message) => message.role === "assistant" && message.providerReplay,
  );
async function largeWindowFixture() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "remember copper", timestamp: 1 });
  manager.appendMessage(
    createAssistant(model, [{ type: "text", text: "settled history" }], "stop", 465_674),
  );
  return fixture(manager, false, { contextTokenBudget: 500_000, contextWindow: 500_000 });
}

async function fixture(
  sessionManager = SessionManager.inMemory(),
  withHistory = true,
  {
    asyncProvider = false,
    nativeProvider = false,
    contextTokenBudget = 8_000,
    contextWindow = model.contextWindow,
  } = {},
) {
  if (withHistory) {
    sessionManager.appendMessage({ role: "user", content: "remember copper", timestamp: 1 });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Old detail. ".repeat(3_500) }], "stop", 7_000),
    );
  }
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "settled result. ".repeat(2_500) }],
    details: {},
  }));
  const { session } = await createTestSession({
    model: { ...model, contextWindow },
    sessionManager,
    systemPrompt: "stable system",
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 2_000 },
      retry: { enabled: false },
    }),
    contextOverflowRecoveryOwner: "caller",
    customTools: [
      {
        name: "lookup",
        label: "lookup",
        description: "read a record",
        parameters: Type.Object({}),
        execute,
      },
    ],
  });
  session.agent.transformContext = async (messages) =>
    normalizeMessagesForLlmBoundary(messages, {
      appendOnlyRuntimeContext: true,
      inHistorySystemUpdates: true,
    });
  session[agentSessionDeferThresholdCompaction] = true;
  const transport = createOpenAIResponsesTransportStreamFn();
  const providerStream: StreamFn = (activeModel, context, options) => {
    const transportOptions = {
      ...options,
      apiKey: options?.apiKey ?? "test-api-key",
      authProfileId: "fixture-profile",
      onPayload: (payload: unknown) => ({ ...(payload as object), hook_marker: "normal-hook" }),
    } satisfies OpenAIResponsesOptions;
    return nativeProvider
      ? streamSimpleOpenAICodexResponses(
          { ...activeModel, api: "openai-chatgpt-responses" },
          context,
          {
            ...transportOptions,
            apiKey: `eyJhbGciOiJub25lIn0.${Buffer.from(
              JSON.stringify({
                "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
              }),
            ).toString("base64url")}.signature`,
            transport: "sse",
          },
        )
      : transport(activeModel, context, transportOptions);
  };
  if (asyncProvider) {
    // Plugin providers resolve credentials before dispatch; the registry adapter
    // returns its stream first, as the native ChatGPT route does in production.
    const registry = createApiRegistry();
    ensureCustomApiRegistered(registry, model.api, async (activeModel, context, options) => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return providerStream(activeModel, context, options);
    });
    const registered = registry.getApiProvider(model.api);
    if (!registered) {
      throw new Error("Expected the registered provider stream");
    }
    session.agent.streamFn = registered.stream as StreamFn;
  } else {
    session.agent.streamFn = providerStream;
  }
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  const onFallback = vi.fn();
  const withTranscriptWrite = <T>(write: () => Promise<T>) =>
    withSessionManagerWrite(sessionManager, write);
  const boundaryParams = {
    session,
    contextTokenBudget,
    reserveTokens: 2_000,
    timeoutMs: 30_000,
    authProfileId: "fixture-profile",
    assertActive: () => {},
    withTranscriptWrite,
    onFallback,
  };
  const onModelRequest =
    vi.fn<NonNullable<Parameters<typeof submitEmbeddedAttemptPrompt>[0]["onModelRequest"]>>();
  const boundary = createChatGPTV2CompactionBoundary(boundaryParams);
  const submit = (prompt = "current request") =>
    submitEmbeddedAttemptPrompt({
      attempt: { sessionId: session.sessionId },
      activeSession: session,
      contextTokenBudget,
      compactBeforeRequest: boundary,
      onModelRequest,
      images: [],
      modelPrompt: prompt,
      transcriptPrompt: prompt,
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      persistToolResultProjections: async () => {},
      withTranscriptWrite,
      runtimeOnly: false,
      systemPrompt: "stable system",
      toolResultAggregateMaxChars: 80_000,
      toolResultMaxChars: 80_000,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      trajectoryRecorder: null,
      transcriptLeafId: sessionManager.getLeafId(),
      appendOnlyRuntimeContext: true,
      runtimeContextMessage:
        buildRuntimeContextCustomMessage("per-turn developer context") ?? undefined,
      promptActiveSession: (text, options) => session.prompt(text, options),
    });
  return {
    session,
    sessionManager,
    execute,
    events,
    onFallback,
    onModelRequest,
    boundary,
    boundaryParams,
    submit,
  };
}

const realUserText = (body: Body) =>
  body.input
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content as Array<{ text?: string }>).map((part) => part.text));

describe("ChatGPT V2 at the embedded normal request boundary", () => {
  it("compacts preflight and settled tool turns through the live stack without reexecuting tools", async () => {
    const f = await fixture();
    let normal = 0;
    let compacted = 0;
    respond = (body) =>
      body.input.at(-1)?.type === "compaction_trigger"
        ? compactEvents(++compacted)
        : ++normal === 1
          ? toolEvents()
          : textEvents();
    await f.submit();
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(4);
    // Each boundary observes the request V2 prices, the compaction, then the checkpoint request.
    expect(
      f.onModelRequest.mock.calls.map(
        ([, context]) =>
          context.messages.filter(
            (message) => message.role === "assistant" && message.providerReplay,
          ).length,
      ),
    ).toEqual([0, 0, 1, 1, 1, 2]);
    const firstCompact = requestAt(0),
      firstNormal = requestAt(1);
    const secondCompact = requestAt(2),
      secondNormal = requestAt(3);
    expect(firstCompact.hook_marker).toBe("normal-hook");
    expect(firstCompact.tools).toEqual(firstNormal.tools);
    expect(firstCompact.instructions).toBe(firstNormal.instructions);
    expect(JSON.stringify(firstCompact)).toContain("per-turn developer context");
    expect(JSON.stringify(firstCompact)).toContain("current request");
    expect(firstNormal.input.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque1" });
    expect(secondCompact.input.some((item) => item.type === "function_call_output")).toBe(true);
    expect(secondNormal.input.some((item) => item.type === "function_call_output")).toBe(false);
    expect(realUserText(secondNormal)).toEqual(realUserText(firstNormal));
    expect(secondNormal.input.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque2" });
    const persisted = f.sessionManager.buildSessionContext().messages;
    expect(persisted.filter((message) => message.role === "user")).toHaveLength(2);
    expect(
      persisted.filter((message) => message.role === "assistant" && message.providerReplay),
    ).toHaveLength(2);
    expect(
      persisted.findLast((message) => message.role === "assistant" && message.providerReplay),
    ).toMatchObject({ providerReplay: { compactedWindow: { outputTokens: 5 } } });
    expect(
      f.events.filter(
        (event) => event.type === "compaction_end" && event.outcome.status === "completed",
      ),
    ).toHaveLength(2);

    // Rehydrate the persisted entries, not the live Agent or boundary closure.
    const reopened = await fixture(
      SessionManager.fromEntries([f.sessionManager.getHeader(), ...f.sessionManager.getEntries()]),
      false,
    );
    requests = [];
    await reopened.submit("after restart");
    expect(requests).toHaveLength(1);
    const resumed = requestAt(0);
    expect(
      resumed.input.some(
        (item) => item.type === "compaction" && item.encrypted_content === "opaque2",
      ),
    ).toBe(true);
    expect(realUserText(resumed)).toEqual([
      ...realUserText(firstNormal),
      "after restart",
      expect.stringContaining("per-turn developer context"),
    ]);
    expect(reopened.execute).not.toHaveBeenCalled();
  });

  it("compacts a settled 90% window before a large tool result reaches the next boundary", async () => {
    const f = await largeWindowFixture();
    const manager = f.sessionManager;
    f.execute.mockResolvedValue({
      content: [{ type: "text", text: "large tool output. ".repeat(16_000) }],
      details: {},
    });
    let normal = 0;
    let compacted = false;
    respond = (body) => {
      if (body.input.at(-1)?.type === "compaction_trigger") {
        compacted = true;
        return compactEvents(1);
      }
      if (++normal !== 1) {
        return textEvents();
      }
      const events = toolEvents();
      if (!compacted) {
        events[events.length - 1] = highUsageCompletion;
      }
      return events;
    };
    await f.submit();
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(requests.map((body) => body.input.at(-1)?.type)).toEqual([
      "compaction_trigger",
      "compaction",
      "function_call_output",
    ]);
    const compaction = requestAt(0),
      firstNormal = requestAt(1),
      afterTool = requestAt(2);
    expect(JSON.stringify(compaction)).toContain("current request");
    expect(realUserText(firstNormal)).toEqual(["remember copper", "current request"]);
    expect(afterTool.input.filter((item) => item.type === "function_call_output")).toHaveLength(1);
    expect(afterTool.input.filter((item) => item.type === "compaction")).toHaveLength(1);
    const reopened = await fixture(
      SessionManager.fromEntries([manager.getHeader(), ...manager.getEntries()]),
      false,
      { contextTokenBudget: 500_000, contextWindow: 500_000 },
    );
    requests = [];
    await reopened.submit("after restart");
    expect(requests).toHaveLength(1);
    const resumed = requestAt(0);
    expect(resumed.input.filter((item) => item.type === "function_call_output")).toHaveLength(1);
    expect(resumed.input.filter((item) => item.type === "compaction")).toHaveLength(1);
    expect(reopened.execute).not.toHaveBeenCalled();
  });

  it.each([
    { window: 500_000, reserve: 20_000, tokens: 449_000, compact: false },
    { window: 500_000, reserve: 20_000, tokens: 450_000, compact: true },
    { window: 32_000, reserve: 8_000, tokens: 23_900, compact: false },
    { window: 32_000, reserve: 8_000, tokens: 24_000, compact: true },
  ])("uses the earlier V2 threshold at $tokens / $window tokens", async (test) => {
    const f = await fixture(SessionManager.inMemory(), false);
    const boundary = createChatGPTV2CompactionBoundary({
      ...f.boundaryParams,
      contextTokenBudget: test.window,
      reserveTokens: test.reserve,
    });
    const result = await boundary(
      f.session.agent.streamFn,
      { ...model, contextWindow: test.window },
      { messages: [] },
      { sessionId: f.session.sessionId },
      { requestIndex: 1, messageCount: 0, contextTokens: test.tokens },
    );
    expect(Boolean(result)).toBe(test.compact);
    expect(requests).toHaveLength(test.compact ? 1 : 0);
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it("skips soft compaction while tools are pending without lowering the client threshold", async () => {
    const f = await fixture(SessionManager.inMemory(), false);
    const boundary = createChatGPTV2CompactionBoundary({
      ...f.boundaryParams,
      contextTokenBudget: 500_000,
      reserveTokens: 20_000,
    });
    let normal = 0;
    respond = () => (++normal === 1 ? toolEvents() : textEvents());
    f.execute.mockImplementation(async () => {
      expect(f.session.agent.state.pendingToolCalls.size).toBe(1);
      await expect(
        boundary(
          f.session.agent.streamFn,
          { ...model, contextWindow: 500_000 },
          { messages: [] },
          { sessionId: f.session.sessionId },
          { requestIndex: 1, messageCount: 0, contextTokens: 465_674 },
        ),
      ).resolves.toBeUndefined();
      return { content: [{ type: "text", text: "settled" }], details: {} };
    });
    await f.submit();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(requests.map((body) => body.input.at(-1)?.type)).toEqual([
      "message",
      "function_call_output",
    ]);
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it("continues normal requests after a soft V2 failure without retrying or client compaction", async () => {
    const f = await largeWindowFixture();
    const manager = f.sessionManager;
    const warn = vi.spyOn(log, "warn");
    respond = (body) =>
      body.input.at(-1)?.type === "compaction_trigger"
        ? [terminal]
        : textEvents().map((event) =>
            event.type === "response.completed" ? highUsageCompletion : event,
          );
    await f.submit();
    await f.submit("next request");
    expect(requests.map((body) => body.input.at(-1)?.type)).toEqual([
      "compaction_trigger",
      "message",
      "message",
    ]);
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(hasReplay(manager)).toBe(false);
  });

  it("prices a matching measured prefix once before deciding to compact", async () => {
    const f = await fixture(SessionManager.inMemory(), false);
    // Mirrors the mid-turn admission contract: a measured 15,000-token request with
    // long unchanged instructions plus a 12,000-character tool result fits 24,576.
    const boundary = createChatGPTV2CompactionBoundary({
      ...f.boundaryParams,
      contextTokenBudget: 32_768,
      reserveTokens: 8_192,
    });
    const context = {
      systemPrompt: "Keep these instructions. ".repeat(2_200),
      messages: [
        { role: "user" as const, content: "read the report", timestamp: 1 },
        createAssistant(
          model,
          [{ type: "toolCall", id: "read-report", name: "read", arguments: {} }],
          "toolUse",
          15_000,
        ),
        {
          role: "toolResult" as const,
          toolCallId: "read-report",
          toolName: "read",
          content: [{ type: "text" as const, text: "r".repeat(12_000) }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    const anchor = { requestIndex: 1, messageCount: 2, contextTokens: 15_000 };
    await expect(
      boundary(
        f.session.agent.streamFn,
        { ...model, contextWindow: 32_768 },
        context,
        { sessionId: f.session.sessionId },
        anchor,
      ),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it("compacts through a provider stream that dispatches after returning", async () => {
    const f = await fixture(SessionManager.inMemory(), true, { asyncProvider: true });
    await f.submit();
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(requests.map((body) => body.input.at(-1)?.type)).toEqual([
      "compaction_trigger",
      "compaction",
    ]);
  });

  it.each([
    { userTokens: 40_000, fits: false, nativeProvider: false },
    { userTokens: 20_000, fits: true, nativeProvider: false },
    { userTokens: 40_000, fits: false, nativeProvider: true },
    { userTokens: 20_000, fits: true, nativeProvider: true },
  ])(
    "preflights retained users before paid V2 work ($userTokens tokens, native=$nativeProvider)",
    async ({ userTokens, fits, nativeProvider }) => {
      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "中".repeat(userTokens), timestamp: 1 });
      manager.appendMessage(
        createAssistant(model, [{ type: "text", text: "old detail" }], "stop", 60_000),
      );
      const f = await fixture(manager, false, { nativeProvider });
      const warn = vi.spyOn(log, "warn");
      const boundary = createChatGPTV2CompactionBoundary({
        ...f.boundaryParams,
        contextTokenBudget: 32_000,
      });
      const result = boundary(
        f.session.agent.streamFn,
        { ...model, contextWindow: 200_000 },
        {
          systemPrompt: "stable system",
          messages: manager
            .buildSessionContext()
            .messages.filter(
              (message) =>
                message.role === "user" ||
                message.role === "assistant" ||
                message.role === "toolResult",
            ),
        },
        { sessionId: f.session.sessionId },
      );
      if (fits) {
        await expect(result).resolves.toMatchObject({
          providerReplay: { compactedWindow: { outputTokens: 5 } },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.input.at(-1)?.type).toBe("compaction_trigger");
        expect(f.onFallback).not.toHaveBeenCalled();
        expect(
          manager
            .buildSessionContext()
            .messages.filter((message) => message.role === "assistant" && message.providerReplay),
        ).toHaveLength(1);
      } else {
        await expect(result).rejects.toBeInstanceOf(MidTurnPrecheckSignal);
        expect(
          manager
            .buildSessionContext()
            .messages.some((message) => message.role === "assistant" && message.providerReplay),
        ).toBe(false);
        expect(requests).toHaveLength(0);
        expect(f.onFallback).toHaveBeenCalledOnce();
        expect(f.onFallback).toHaveBeenCalledWith(
          expect.objectContaining({ route: "compact_only" }),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("ChatGPT V2 retained window exceeds the next request budget"),
        );
      }
    },
  );

  it("falls back before transport dispatch when the outgoing input exceeds the hard model budget", async () => {
    const f = await fixture();
    await f.submit("Oversized current input. ".repeat(10_000));
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.onFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "compact_only",
        estimatedPromptTokens: expect.any(Number),
      }),
    );
    expect(f.onFallback.mock.calls[0]?.[0].estimatedPromptTokens).toBeGreaterThan(
      model.contextWindow,
    );
    expect(requests).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("falls back once on an invalid checkpoint without persisting or dispatching foreground work", async () => {
    const f = await fixture();
    const warn = vi.spyOn(log, "warn");
    respond = () => [terminal];
    await f.submit();
    expect(requests).toHaveLength(1);
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exactly one nonempty compaction item"),
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      f.sessionManager
        .buildSessionContext()
        .messages.some((message) => message.role === "assistant" && message.providerReplay),
    ).toBe(false);
  });

  it("preserves retained input despite configured log redaction patterns", async () => {
    const f = await fixture();
    const boundary = createChatGPTV2CompactionBoundary({
      ...f.boundaryParams,
      config: { logging: { redactPatterns: ["PRIVATE_VALUE"] } },
    });
    const content = "PRIVATE_VALUE API_TOKEN = computeToken()";
    const messages: Context["messages"] = [
      { role: "user", content, timestamp: 1 },
      ...persistedMessages(f.sessionManager).filter(
        (message) => message.role === "assistant" || message.role === "toolResult",
      ),
    ];
    await expect(
      boundary(f.session.agent.streamFn, model, { messages }, {}),
    ).resolves.toMatchObject({ providerReplay: { compactedWindow: { outputTokens: 5 } } });
    expect(requests).toHaveLength(1);
    expect(requests.map(realUserText)).toEqual([[content]]);
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it("never falls back after a committed checkpoint or caller abort", async () => {
    const f = await fixture();
    const failure = new Error("write handle release failed");
    const boundary = createChatGPTV2CompactionBoundary({
      ...f.boundaryParams,
      withTranscriptWrite: async (write) => {
        await f.boundaryParams.withTranscriptWrite(write);
        throw failure;
      },
    });
    await expect(
      boundary(
        f.session.agent.streamFn,
        model,
        {
          messages: f.session.messages.filter(
            (message) =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
        },
        { sessionId: f.session.sessionId },
      ),
    ).rejects.toBe(failure);
    expect(f.onFallback).not.toHaveBeenCalled();
    expect(hasReplay(f.sessionManager)).toBe(true);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      f.boundary(f.session.agent.streamFn, model, { messages: [] }, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it("does not cover transcript entries admitted while V2 is pending", async () => {
    const f = await fixture();
    respond = () => {
      f.sessionManager.appendMessage({
        role: "user",
        content: "newly admitted input",
        timestamp: 3,
      });
      return compactEvents(1);
    };
    await f.submit();
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(hasReplay(f.sessionManager)).toBe(false);
    expect(
      persistedMessages(f.sessionManager).some(
        (message) => message.role === "user" && message.content === "newly admitted input",
      ),
    ).toBe(true);
  });

  it("keeps explicit opt-outs, proxy routes and custom compaction owners out of V2", () => {
    const eligible = {
      model,
      extraParams: {},
      compactionEnabled: true,
      compactionReplayEnabled: true,
    };
    expect(isChatGPTV2CompactionEligible(eligible)).toBe(true);
    for (const override of [
      { compactionEnabled: false },
      { compactionReplayEnabled: false },
      { extraParams: { responsesCompactEndpoint: false } },
      { extraParams: { responsesServerCompaction: false } },
      { contextEngineOwnsCompaction: true },
      { config: { agents: { defaults: { compaction: { model: "other/model" } } } } },
      { config: { agents: { defaults: { compaction: { provider: "custom" } } } } },
      { operation: "settled-tool-finalization" },
      { model: { ...model, baseUrl: "https://proxy.invalid" } },
      { model: { ...model, api: "openai-responses" } },
    ]) {
      expect(isChatGPTV2CompactionEligible({ ...eligible, ...override })).toBe(false);
    }
  });
});
