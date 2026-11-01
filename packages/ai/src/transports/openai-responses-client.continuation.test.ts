import path from "node:path";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "../../../../src/agents/agent-tool-definition-adapter.js";
import { wrapStreamFnWithProviderPromptState } from "../../../../src/agents/embedded-agent-runner/provider-prompt-state.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { SessionManager } from "../../../../src/agents/sessions/session-manager.js";
import { wrapToolDefinition } from "../../../../src/agents/sessions/tools/tool-definition-wrapper.js";
import { createSessionsYieldTool } from "../../../../src/agents/tools/sessions-yield-tool.js";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { createDiagnosticTraceContext } from "../../../../src/infra/diagnostic-trace-context.js";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
} from "../../../../src/shared/immutable-data.js";
import { useSessionStoreTempDirs } from "../../../../src/test-utils/session-state-cleanup.js";
import { createDeferred, withTestTimeout } from "../../../../test/helpers/promise.js";
import { Agent } from "../../../agent-core/src/agent.js";
import type { SdkResponse } from "./openai-responses-sdk.test-support.js";
import {
  completedResponse,
  outputItem,
  userMessage,
  wireCall,
} from "./openai-stream-cases.test-support.js";

const sseState = vi.hoisted(() => ({
  clientHeaders: [] as Array<Record<string, string>>,
  outcomes: [] as Array<Error | SdkResponse>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", async () => {
  const { createResponsesSdkMock } = await import("./openai-responses-sdk.test-support.js");
  return createResponsesSdkMock(sseState, {
    onConstruct: (options) => sseState.clientHeaders.push(options.defaultHeaders ?? {}),
  });
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    private outcome?: Error | SdkResponse;
    send(request: Record<string, unknown>) {
      sseState.requests.push(request);
      this.outcome = sseState.outcomes.shift();
    }
    close() {
      this.socket.readyState = 3;
    }
    on() {
      return this;
    }
    async *stream() {
      yield { type: "open" };
      if (!this.outcome || this.outcome instanceof Error) {
        throw this.outcome ?? new Error("Unexpected WebSocket request");
      }
      for await (const message of this.outcome.data) {
        yield { type: "message", message };
      }
    }
  },
}));

import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";

const initialHost = getAiTransportHost();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-responses-transcript-");
const model = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  name: "GPT-5.6 Luna",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 200_000,
}) satisfies Model<"openai-responses">;
const astra = { ...model, id: "gpt-6-astra", name: "GPT-6 Astra" };

function functionTool(name: string) {
  return { name, description: name, parameters: Type.Object({}) };
}

const asyncCall = { ...wireCall("lookup", "lookup"), status: "completed", async: true };

function completedEvent(responseId: string, content: string) {
  const output = [
    {
      id: `msg_${responseId}`,
      type: "message",
      status: "completed",
      content: [
        {
          annotations: [
            {
              type: "url_citation",
              url: "https://example.test/source",
              title: "source",
              start_index: 0,
              end_index: content.length,
            },
          ],
          logprobs: [{ token: content, logprob: -0.1, bytes: [], top_logprobs: [] }],
          text: content,
          type: "output_text",
        },
      ],
      role: "assistant",
    },
  ];
  return completedResponse(responseId, output, {
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  });
}

function sdkCompletion(responseId: string, content: string): SdkResponse {
  return sdkEvents(completedEvent(responseId, content));
}

/** A completion without url_citation, for tool-flow tests whose replies cite nothing. */
function sdkUncitedCompletion(responseId: string, content: string): SdkResponse {
  const event = completedEvent(responseId, content);
  for (const item of event.response.output) {
    for (const part of item.content) {
      part.annotations = [];
    }
  }
  return sdkEvents(event);
}

function sdkEvents(...events: Array<Record<string, unknown>>): SdkResponse {
  return {
    data: (async function* () {
      yield* events;
    })(),
    response: new Response(null, { status: 200 }),
  };
}

const unoptedCustomEndpointModel = {
  ...model,
  provider: "omniroute",
  baseUrl: "https://omniroute.example.com/v1",
} satisfies Model<"openai-responses">;

async function run(
  context: Context,
  options: {
    sessionId?: string;
    cacheRetention?: "none" | "short";
    onPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
    signal?: AbortSignal;
    reasoningEffort?: "low" | "medium" | "high";
    transport?: "sse" | "websocket-cached";
    asyncToolExecution?: boolean;
    openclawCodeModeToolSurface?: boolean;
  },
  requestModel: Model = model,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(requestModel, context, {
    apiKey: "test-key",
    sessionId: options.sessionId ?? "session-1",
    cacheRetention: options.cacheRetention,
    transport: options.transport ?? "sse",
    reasoningEffort: options.reasoningEffort ?? "low",
    asyncToolExecution: options.asyncToolExecution,
    openclawCodeModeToolSurface: options.openclawCodeModeToolSurface,
    onPayload: options.onPayload,
    signal: options.signal,
  } as never);
  return stream.result();
}

describe("native OpenAI Responses SSE continuation", () => {
  beforeEach(() => {
    cleanupSessionResources();
    sseState.clientHeaders.length = 0;
    sseState.outcomes.length = 0;
    sseState.requests.length = 0;
    let turn = 0;
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: ({ context }) => {
          turn += 1;
          return {
            headers: {
              "x-openclaw-session-id": context.sessionId ?? "",
              "x-openclaw-turn-id": `turn-${turn}`,
              "x-openclaw-turn-attempt": "1",
            },
            metadata: {
              openclaw_session_id: context.sessionId ?? "",
              openclaw_turn_id: `turn-${turn}`,
              openclaw_turn_attempt: "1",
              openclaw_transport: context.transport,
            },
            websocket: { headers: { "x-openclaw-session-id": context.sessionId ?? "" } },
          };
        },
      },
    });
  });

  afterEach(async () => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
    if (vi.isFakeTimers()) {
      await vi.runAllTimersAsync();
    }
    vi.useRealTimers();
  });

  it("retains prefix ownership through diagnostic observers while isolating mutating hooks", async () => {
    configureAiTransportHost({
      ...getAiTransportHost(),
      immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
    });
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      wrapStreamFnWithProviderPromptState({
        streamFn: createOpenAIResponsesTransportStreamFn(),
        state: {},
        effectiveContextTokenBudget: 200_000,
      }),
      {
        runId: "prefix-owner",
        provider: astra.provider,
        model: astra.id,
        api: astra.api,
        trace: createDiagnosticTraceContext({}),
        nextCallId: () => "prefix-call",
        suppressPluginHooks: true,
      },
    );
    const text = "retained history must not be encoded again";
    const messages: Context["messages"] = [freezeJsonSnapshot(userMessage(text, 1))];
    const request = async (onPayload?: (payload: unknown) => void) => {
      sseState.outcomes.push(sdkUncitedCompletion(`resp_${sseState.requests.length}`, "answer"));
      const options = {
        apiKey: "synthetic-key",
        reasoningEffort: "low",
        onPayload,
      } satisfies OpenAIResponsesOptions;
      const stream = await wrapped(astra, { messages }, options);
      for await (const event of stream) {
        void event;
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(result).toHaveProperty("openclawResponsesInputReplay.reasoning.prefixHash");
      return result;
    };
    messages.push(freezeJsonSnapshot(await request()), freezeJsonSnapshot(userMessage("next", 2)));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      await request();
      expect(stringify.mock.calls.filter(([value]) => value === text)).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }
    expect(sseState.requests[1]?.input).toHaveProperty("0.content.0.text", text);
    await request((payload) => {
      const changed = payload as { input: [{ content: [{ text: string }] }] };
      changed.input[0].content[0].text = "hook edit";
    });
    expect(sseState.requests[2]?.input).toHaveProperty("0.content.0.text", "hook edit");
    expect(sseState.requests[0]?.input).toHaveProperty("0.content.0.text", text);
  });

  it.each(["short"] as const)(
    "continues stateful SSE turns with %s retention and matching affinity",
    async (cacheRetention) => {
      sseState.outcomes.push(
        sdkCompletion("resp_1", "first answer"),
        sdkCompletion("resp_2", "second answer"),
      );
      const firstUser = userMessage("first question", 1);
      const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
      const requestModel = { ...model, compat: { sendSessionIdHeader: true } };
      const first = await run(
        { messages: [firstUser], tools: [] },
        { onPayload, cacheRetention },
        requestModel,
      );
      const second = await run(
        { messages: [firstUser, first, userMessage("second question", 2)], tools: [] },
        { onPayload, cacheRetention },
        requestModel,
      );

      expect(second.stopReason).toBe("stop");
      expect(sseState.clientHeaders).toMatchObject([
        { "x-openclaw-turn-id": "turn-1" },
        { "x-openclaw-turn-id": "turn-2" },
      ]);
      expect(sseState.clientHeaders.map((headers) => headers.session_id)).toEqual([
        "session-1",
        "session-1",
      ]);
      expect(sseState.requests[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second question" }],
          },
        ],
      });
    },
  );

  it("continues after a hosted web search answer with sources through effort and tool turns", async () => {
    const search = completedEvent("resp_search", "searched answer");
    const toolCall = { ...wireCall("lookup", "lookup"), status: "completed" };
    const toolTurn = completedEvent("resp_tool", "");
    sseState.outcomes.push(
      sdkEvents({
        ...search,
        response: {
          ...search.response,
          output: [
            {
              type: "web_search_call",
              id: "ws_1",
              status: "completed",
              action: { type: "search", query: "source" },
            },
            ...search.response.output,
          ],
        },
      }),
      sdkEvents(outputItem("added", { ...toolCall, arguments: "" }), outputItem("done", toolCall), {
        ...toolTurn,
        response: { ...toolTurn.response, output: [toolCall] },
      }),
      sdkCompletion("resp_final", "used lookup result"),
    );
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const tools = [functionTool("lookup")];
    const messages: Context["messages"] = [userMessage("first question", 1)];
    const first = await run({ messages, tools }, { onPayload }, astra);
    // Sources reach the visible reply; the server keeps only the provider prose.
    expect(first.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: "searched answer\n\n[source](https://example.test/source)",
      }),
    );
    messages.push(first, userMessage("second question", 2));
    const second = await run({ messages, tools }, { onPayload, reasoningEffort: "high" }, astra);
    expect(second.stopReason).toBe("toolUse");
    const call = second.content.find((block) => block.type === "toolCall");
    if (call?.type !== "toolCall") {
      throw new Error("Expected the lookup tool call");
    }
    messages.push(second, {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "lookup result" }],
      isError: false,
      timestamp: 3,
    });
    const third = await run({ messages, tools }, { onPayload, reasoningEffort: "high" }, astra);

    expect(third.stopReason).toBe("stop");
    expect(sseState.requests[1]).toMatchObject({
      previous_response_id: "resp_search",
      reasoning: { effort: "low" },
      input: [
        { type: "configuration_update", reasoning: { effort: "high" } },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second question" }],
        },
      ],
    });
    expect(sseState.requests[2]).toMatchObject({
      previous_response_id: "resp_tool",
      reasoning: { effort: "low" },
      input: [{ type: "function_call_output", call_id: "call_lookup", output: "lookup result" }],
    });
    expect(sseState.requests[2]?.input).toHaveLength(1);
  });

  it("never engages for a custom endpoint without the explicit opt-in, even with store:true forced (the host carries no trust signal on its own)", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
    );
    const firstUser = userMessage("first question", 1);
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const first = await run(
      { messages: [firstUser], tools: [] },
      { onPayload },
      unoptedCustomEndpointModel,
    );
    await run(
      { messages: [firstUser, first, userMessage("second question", 2)], tools: [] },
      { onPayload },
      unoptedCustomEndpointModel,
    );

    expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
    expect(sseState.requests[1]?.input).toHaveLength(3);
  });

  it.each([{ transport: "websocket-cached", reset: "expiry" }] as const)(
    "preserves effort controls through $transport $reset and transcript reload",
    async ({ transport }) => {
      vi.useFakeTimers();
      sseState.outcomes.push(
        sdkCompletion("resp_1", "first answer"),
        sdkCompletion("resp_2", "second answer"),
        sdkCompletion("resp_3", "third answer"),
      );
      const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: false });
      const options = { onPayload, transport };
      const messages: Context["messages"] = [userMessage("first question", 1)];
      const first = await run({ messages }, options, astra);
      messages.push(first, userMessage("second question", 2));
      const second = await run({ messages }, { ...options, reasoningEffort: "high" }, astra);
      messages.push(second, userMessage("third question", 3));
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const serialized = JSON.stringify(messages);
      const third = await run(
        { messages: JSON.parse(serialized) },
        { ...options, reasoningEffort: "medium" },
        astra,
      );
      expect([first.stopReason, second.stopReason, third.stopReason]).toEqual([
        "stop",
        "stop",
        "stop",
      ]);
      const configuration = { type: "configuration_update", reasoning: { effort: "high" } };
      expect(sseState.requests[1]).toMatchObject({ reasoning: { effort: "low" } });
      expect(sseState.requests[1]?.input).toContainEqual(configuration);
      expect(sseState.requests[2]).toMatchObject({
        reasoning: { effort: "low", summary: "auto" },
        input: [
          { role: "user", content: [{ text: "first question" }] },
          { role: "assistant", content: [{ text: "first answer" }] },
          configuration,
          { role: "user", content: [{ text: "second question" }] },
          { role: "assistant", content: [{ text: "second answer" }] },
          { type: "configuration_update", reasoning: { effort: "medium" } },
          { role: "user", content: [{ text: "third question" }] },
        ],
      });
      expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
      expect(sseState.requests[1]).toHaveProperty("previous_response_id", "resp_1");
      expect(sseState.requests[2]).toHaveProperty("type", "response.create");
    },
  );

  it("round-trips reasoning state through the SQLite session transcript", async () => {
    configureAiTransportHost({
      ...initialHost,
      plugin: { ...initialHost.plugin, resolveTransportTurnState: () => undefined },
    });
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_warm", "third answer"),
      sdkCompletion("resp_reloaded", "third answer"),
    );
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: false });
    const messages: Context["messages"] = [userMessage("first question", 1)];
    messages.push(await run({ messages }, { onPayload }, astra), userMessage("second question", 2));
    messages.push(
      await run({ messages }, { onPayload, reasoningEffort: "high" }, astra),
      userMessage("third question", 3),
    );
    expect(sseState.requests[1]?.input).toContainEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
    const options = {
      onPayload,
      reasoningEffort: "medium" as const,
      sessionId: "session-1",
    };
    expect((await run({ messages }, options, astra)).stopReason).toBe("stop");
    const expectedRequest = sseState.requests.at(-1);
    expect(expectedRequest).toMatchObject({
      reasoning: { effort: "low" },
    });
    expect(expectedRequest?.input).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      { type: "configuration_update", reasoning: { effort: "high" } },
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      { type: "configuration_update", reasoning: { effort: "medium" } },
      expect.objectContaining({ role: "user" }),
    ]);
    const dir = sessionDirs.make();
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:responses-reasoning",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, dir);
    for (const message of messages) {
      // This append traverses the production transcript redactor and SQLite store.
      manager.appendMessage(message);
    }
    cleanupSessionResources();
    const reloaded = SessionManager.open(scope, dir).buildSessionContext().messages;
    expect(reloaded).toEqual(messages);
    const requestMessages = reloaded.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new Error(`Unexpected persisted message role: ${message.role}`);
      }
      return message;
    });
    expect((await run({ messages: requestMessages }, options, astra)).stopReason).toBe("stop");
    expect(sseState.requests.at(-1)).toEqual(expectedRequest);
    expect(sseState.requests.at(-1)).not.toHaveProperty("previous_response_id");
  });

  it.each([
    "model",
    "mode",
    "server compaction",
    "compacted history",
    "edited history",
    "request settings",
  ])("resets durable effort controls after %s changes", async (change) => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_3", "third answer"),
    );
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: false });
    let messages: Context["messages"] = [userMessage("first question", 1)];
    const first = await run({ messages }, { onPayload }, astra);
    messages.push(first, userMessage("second question", 2));
    const second = await run({ messages }, { onPayload, reasoningEffort: "high" }, astra);
    messages.push(second, userMessage("third question", 3));
    expect(sseState.requests[1]?.input).toContainEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
    cleanupSessionResources();
    if (change === "compacted history") {
      messages = [userMessage("compacted summary", 0), ...messages.slice(3)];
    } else if (change === "edited history") {
      messages[0] = userMessage("edited question", 1);
    }
    const serialized = JSON.stringify(messages);
    const third = await run(
      { messages: JSON.parse(serialized) },
      {
        reasoningEffort: "medium",
        onPayload: (payload) => ({
          ...onPayload(payload),
          ...(change === "mode" ? { reasoning: { effort: "medium", mode: "pro" } } : {}),
          ...(change === "server compaction"
            ? { context_management: [{ type: "compaction", compact_threshold: 1000 }] }
            : {}),
          ...(change === "request settings" ? { max_output_tokens: 512 } : {}),
        }),
      },
      change === "model" ? model : astra,
    );
    expect(third.stopReason).toBe("stop");
    expect(sseState.requests[2]).toMatchObject({ reasoning: { effort: "medium" } });
    expect(sseState.requests[2]?.input).not.toContainEqual(
      expect.objectContaining({ type: "configuration_update" }),
    );
  });

  it("executes an Astra tool before SSE completes and returns its result once", async () => {
    const toolStarted = createDeferred();
    const releaseTool = createDeferred();
    const responseCompleted = createDeferred();
    const execute = vi.fn(async () => {
      toolStarted.resolve();
      await releaseTool.promise;
      return { content: [{ type: "text" as const, text: "lookup result" }], details: {} };
    });
    sseState.outcomes.push(
      {
        response: new Response(null, { status: 200 }),
        data: (async function* () {
          yield outputItem("added", { ...asyncCall, arguments: "" });
          yield outputItem("done", asyncCall);
          await withTestTimeout(toolStarted.promise, 5000, "Async tool did not start during SSE");
          const completed = completedEvent("resp_async", "independent answer");
          yield outputItem("done", completed.response.output[0], 1);
          responseCompleted.resolve();
          yield {
            ...completed,
            response: { ...completed.response, output: [asyncCall, ...completed.response.output] },
          };
        })(),
      },
      sdkUncitedCompletion("resp_final", "used lookup result"),
    );
    const agent = new Agent({
      initialState: {
        model: astra,
        thinkingLevel: "low",
        tools: [
          { ...functionTool("lookup"), label: "lookup", execute },
          {
            ...functionTool("sessions_yield"),
            label: "sessions_yield",
            async: false,
            execute: vi.fn(),
          },
        ],
      },
      streamFn: createOpenAIResponsesTransportStreamFn(),
      getApiKey: () => "test-key",
      sessionId: "async-agent",
      transport: "sse",
    });
    const prompt = agent.prompt("Start a lookup and explain something independent.");
    try {
      await withTestTimeout(
        responseCompleted.promise,
        5000,
        "SSE did not continue while the tool ran",
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(sseState.requests).toHaveLength(1);
      expect(sseState.requests[0]?.tools).toEqual([
        expect.objectContaining({ name: "lookup", async: true }),
        expect.not.objectContaining({ async: true }),
      ]);
      releaseTool.resolve();
      await prompt;
      expect(sseState.requests).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(1);
      const replay = sseState.requests[1]?.input as Array<{
        type: string;
        call_id?: string;
        output?: string;
      }>;
      expect(replay.filter((item) => item.type === "function_call_output")).toEqual([
        { type: "function_call_output", call_id: "call_lookup", output: "lookup result" },
      ]);
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [expect.objectContaining({ text: "used lookup result" })],
      });
    } finally {
      releaseTool.resolve();
      agent.abort();
      await prompt;
    }
  });

  it("keeps Astra tools synchronous without sessions_yield to collect async results", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "lookup result" }],
      details: {},
    }));
    const call = { ...wireCall("lookup", "lookup"), status: "completed" };
    const completed = completedEvent("resp_call", "");
    sseState.outcomes.push(
      sdkEvents(outputItem("added", { ...call, arguments: "" }), outputItem("done", call), {
        ...completed,
        response: { ...completed.response, output: [call] },
      }),
      sdkUncitedCompletion("resp_final", "used lookup result"),
    );
    // plugins is synchronous but cannot collect async results (cron surfaces lack sessions_yield).
    const agent = new Agent({
      initialState: {
        model: astra,
        thinkingLevel: "low",
        tools: [
          { ...functionTool("lookup"), label: "lookup", execute },
          { ...functionTool("plugins"), label: "plugins", async: false, execute: vi.fn() },
        ],
      },
      streamFn: createOpenAIResponsesTransportStreamFn(),
      getApiKey: () => "test-key",
      sessionId: "sync-agent",
      transport: "sse",
    });
    await agent.prompt("Look it up and report.");
    expect(sseState.requests[0]?.tools).not.toContainEqual(
      expect.objectContaining({ async: true }),
    );
    expect(sseState.requests).toHaveLength(2);
    const replay = sseState.requests[1]?.input as Array<{ type: string }>;
    expect(replay.filter((item) => item.type === "function_call_output")).toEqual([
      { type: "function_call_output", call_id: "call_lookup", output: "lookup result" },
    ]);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ text: "used lookup result" })],
    });
  });

  it.each([
    { name: "code mode", requestModel: astra, enabled: true, codeMode: true, expected: false },
    {
      name: "API multi-agent",
      requestModel: astra,
      enabled: true,
      multiAgent: true,
      expected: false,
    },
  ])(
    "gates async advertisement and normalized calls for $name",
    async ({ requestModel, enabled, codeMode, multiAgent, expected }) => {
      const completed = completedEvent("resp_call", "");
      sseState.outcomes.push(
        sdkEvents(
          outputItem("added", { ...asyncCall, arguments: "" }),
          outputItem("done", asyncCall),
          { ...completed, response: { ...completed.response, output: [asyncCall] } },
        ),
      );
      const result = await run(
        { messages: [userMessage("call", 1)], tools: [functionTool("exec"), functionTool("wait")] },
        {
          asyncToolExecution: enabled,
          openclawCodeModeToolSurface: codeMode,
          onPayload: (payload) => ({
            ...payload,
            ...(multiAgent ? { multi_agent: { enabled: true } } : {}),
          }),
        },
        requestModel,
      );
      expect(result.stopReason).toBe("toolUse");
      const tools = sseState.requests[0]?.tools as Array<{ async?: boolean }>;
      expect(tools.every((tool) => tool.async === (expected ? true : undefined))).toBe(true);
      expect(result.content.find((item) => item.type === "toolCall")?.async).toBe(
        expected ? true : undefined,
      );
    },
  );

  it("keeps the session's sessions_yield synchronous so a yield pauses the response", async () => {
    sseState.outcomes.push(sdkCompletion("resp_wait", "waiting"));
    const sessionTools = toToolDefinitions([
      createSessionsYieldTool({ sessionId: "session" }),
      {
        ...functionTool("exec"),
        label: "exec",
        execute: async () => ({ content: [], details: {} }),
      },
    ]).map((definition) => wrapToolDefinition(definition));
    await run(
      { messages: [userMessage("wait", 1)], tools: sessionTools },
      { asyncToolExecution: true, onPayload: (payload) => payload },
      astra,
    );
    expect(sseState.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: "exec", async: true }),
      expect.objectContaining({ name: "sessions_yield" }),
    ]);
    expect(sseState.requests[0]?.tools).not.toContainEqual(
      expect.objectContaining({ name: "sessions_yield", async: true }),
    );
  });

  it.each<{ rejection: string; error: { code: string; param?: string; status: number } }>([
    {
      rejection:
        "Previous response cannot be used for this organization due to Zero Data Retention.",
      error: { code: "unsupported_parameter", param: "previous_response_id", status: 400 },
    },
  ])(
    "recovers a continuation rejected with $error.code using full history",
    async ({ rejection, error }) => {
      sseState.outcomes.push(
        sdkCompletion("resp_1", "first answer"),
        Object.assign(new Error(`400 ${rejection}`), error),
        sdkCompletion("resp_2", "second answer"),
        sdkCompletion("resp_3", "third answer"),
      );
      const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
      const firstUser = userMessage("first question", 1);
      const first = await run({ messages: [firstUser], tools: [] }, { onPayload });
      const secondContext = {
        messages: [firstUser, first, userMessage("second question", 2)],
        tools: [],
      };
      const second = await run(secondContext, { onPayload });
      expect(second.stopReason).toBe("stop");
      await run(
        {
          messages: [...secondContext.messages, second, userMessage("third question", 3)],
          tools: [],
        },
        { onPayload },
      );

      expect(sseState.requests).toHaveLength(4);
      expect(sseState.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
      expect(sseState.requests[1]?.input).toHaveLength(1);
      expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
      expect(sseState.requests[2]?.input).toHaveLength(3);
      expect(sseState.requests[3]).toMatchObject({ previous_response_id: "resp_2" });
      expect(sseState.requests[3]?.input).toHaveLength(1);
    },
  );

  it("records the effective full-history compaction recovery request", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      Object.assign(new Error("invalid encrypted content"), {
        code: "invalid_encrypted_content",
      }),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_3", "third answer"),
    );
    const stateful = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const withCompaction = (payload: Record<string, unknown>) => ({
      ...payload,
      store: true,
      input: [
        ...((payload.input as unknown[]) ?? []),
        { type: "compaction", encrypted_content: "opaque" },
      ],
    });
    const firstUser = userMessage("first question", 1);
    const first = await run({ messages: [firstUser], tools: [] }, { onPayload: stateful });
    const secondContext = {
      messages: [firstUser, first, userMessage("second question", 2)],
      tools: [],
    };
    const second = await run(secondContext, { onPayload: withCompaction });
    await run(
      {
        messages: [...secondContext.messages, second, userMessage("third question", 3)],
        tools: [],
      },
      { onPayload: stateful },
    );

    expect(sseState.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(JSON.stringify(sseState.requests[1]?.input)).toContain('"compaction"');
    expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(sseState.requests[2]?.input)).not.toContain('"compaction"');
    expect(sseState.requests[3]).toMatchObject({ previous_response_id: "resp_2" });
  });

  it.each([
    "continuation error without previous_response_id",
    "post-dispatch stream rejection",
    "abort",
  ])("does not commit after %s", async (failure) => {
    const controller = new AbortController();
    if (failure === "continuation error without previous_response_id") {
      sseState.outcomes.push(
        Object.assign(new Error("previous response not found"), {
          code: "previous_response_not_found",
          status: 400,
        }),
      );
    } else if (failure === "post-dispatch stream rejection") {
      sseState.outcomes.push(
        sdkEvents({
          type: "error",
          code: "previous_response_not_found",
          message: "previous response not found after stream acceptance",
        }),
      );
    } else {
      sseState.outcomes.push({
        data: (async function* () {
          controller.abort();
          yield completedEvent("resp_aborted", "ignored");
        })(),
        response: new Response(null, { status: 200 }),
      });
    }
    sseState.outcomes.push(sdkCompletion("resp_next", "next answer"));
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const sessionId = `session-${failure}`;
    await run(
      { messages: [userMessage("first", 1)], tools: [] },
      {
        onPayload,
        sessionId,
        signal: failure === "abort" ? controller.signal : undefined,
      },
    );
    await run({ messages: [userMessage("next", 2)], tools: [] }, { onPayload, sessionId });

    expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
  });
});
