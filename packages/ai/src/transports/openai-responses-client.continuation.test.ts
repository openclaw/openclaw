import path from "node:path";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "../../../../src/agents/agent-tool-definition-adapter.js";
import { SessionManager } from "../../../../src/agents/sessions/session-manager.js";
import { wrapToolDefinition } from "../../../../src/agents/sessions/tools/tool-definition-wrapper.js";
import { createSessionsYieldTool } from "../../../../src/agents/tools/sessions-yield-tool.js";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../../../src/test-utils/session-state-cleanup.js";
import { createDeferred, withTestTimeout } from "../../../../test/helpers/promise.js";
import { Agent } from "../../../agent-core/src/agent.js";
import type { AgentTool } from "../../../agent-core/src/types.js";
import type { SdkResponse } from "./openai-responses-sdk.test-support.js";
import {
  completedResponse,
  outputItem,
  userMessage,
  wireCall,
  wireMessage,
  wireUser,
} from "./openai-stream-cases.test-support.js";

const sseState = vi.hoisted(() => ({
  outcomes: [] as Array<Error | SdkResponse>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", async () => {
  const { createResponsesSdkMock } = await import("./openai-responses-sdk.test-support.js");
  return createResponsesSdkMock(sseState);
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
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

const initialHost = getAiTransportHost();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-responses-transcript-");
const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const astra = { ...model, id: "gpt-6-astra", name: "GPT-6 Astra" };

function functionTool(name: string) {
  return { name, description: name, parameters: Type.Object({}) };
}

const lookupCall = { ...wireCall("lookup", "lookup"), status: "completed" };
const asyncCall = { ...lookupCall, async: true };
const store = (payload: Record<string, unknown>) => ({ ...payload, store: true });
const noStore = (payload: Record<string, unknown>) => ({ ...payload, store: false });
const configuration = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const lookupOutput = {
  type: "function_call_output",
  call_id: "call_lookup",
  output: "lookup result",
};

function completedEvent(responseId: string, content: string, cited = true) {
  const item = wireMessage(`msg_${responseId}`, content);
  return completedResponse(
    responseId,
    [
      {
        ...item,
        content: [
          {
            ...item.content[0],
            annotations: cited
              ? [
                  {
                    type: "url_citation",
                    url: "https://example.test/source",
                    title: "source",
                    start_index: 0,
                    end_index: content.length,
                  },
                ]
              : [],
            logprobs: [{ token: content, logprob: -0.1, bytes: [], top_logprobs: [] }],
          },
        ],
      },
    ],
    { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
  );
}

function sdkCompletion(responseId: string, content: string): SdkResponse {
  return sdkEvents(completedEvent(responseId, content));
}

function sdkUncitedCompletion(responseId: string, content: string): SdkResponse {
  return sdkEvents(completedEvent(responseId, content, false));
}

function sdkEvents(...events: Array<Record<string, unknown>>): SdkResponse {
  return {
    data: (async function* () {
      yield* events;
    })(),
    response: new Response(null, { status: 200 }),
  };
}

function toolEvents(call = lookupCall, responseId = "resp_call") {
  const completed = completedEvent(responseId, "");
  return sdkEvents(outputItem("added", { ...call, arguments: "" }), outputItem("done", call), {
    ...completed,
    response: { ...completed.response, output: [call] },
  });
}

function queueAnswers(count = 3) {
  for (let index = 0; index < count; index++) {
    sseState.outcomes.push(
      sdkCompletion(`resp_${index + 1}`, `${["first", "second", "third"][index]} answer`),
    );
  }
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
    onPayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
    signal?: AbortSignal;
    reasoningEffort?: "low" | "medium" | "high";
    transport?: "sse" | "websocket-cached";
    asyncToolExecution?: boolean;
    openclawCodeModeToolSurface?: boolean;
  } = {},
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
    onPayload: options.onPayload ?? store,
    signal: options.signal,
  } as never);
  return stream.result();
}

async function firstTwoTurns(
  options: Parameters<typeof run>[1] = {},
  requestModel: Model = model,
  secondOptions: Parameters<typeof run>[1] = { ...options, reasoningEffort: "high" },
) {
  const messages: Context["messages"] = [userMessage("first question", 1)];
  const first = await run({ messages }, options, requestModel);
  messages.push(first, userMessage("second question", 2));
  const second = await run({ messages }, secondOptions, requestModel);
  messages.push(second, userMessage("third question", 3));
  return { messages, first, second };
}

function toolAgent(execute: AgentTool["execute"], collector: string) {
  return new Agent({
    initialState: {
      model: astra,
      thinkingLevel: "low",
      tools: [
        { ...functionTool("lookup"), label: "lookup", execute },
        { ...functionTool(collector), label: collector, async: false, execute: vi.fn() },
      ],
    },
    streamFn: createOpenAIResponsesTransportStreamFn(),
    getApiKey: () => "test-key",
    sessionId: collector === "sessions_yield" ? "async-agent" : "sync-agent",
    transport: "sse",
  });
}

function expectToolResult(agent: Agent) {
  expect(sseState.requests).toHaveLength(2);
  const replay = sseState.requests[1]?.input as Array<{ type: string }>;
  expect(replay.filter((item) => item.type === "function_call_output")).toEqual([lookupOutput]);
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [expect.objectContaining({ text: "used lookup result" })],
  });
}

describe("native OpenAI Responses SSE continuation", () => {
  beforeEach(() => {
    cleanupSessionResources();
    sseState.outcomes.length = 0;
    sseState.requests.length = 0;
    configureAiTransportHost({
      ...initialHost,
      plugin: { ...initialHost.plugin, resolveTransportTurnState: () => undefined },
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

  it("continues after a hosted web search answer with sources through effort and tool turns", async () => {
    const search = completedEvent("resp_search", "searched answer");
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
      toolEvents(lookupCall, "resp_tool"),
      sdkCompletion("resp_final", "used lookup result"),
    );
    const tools = [functionTool("lookup")];
    const messages: Context["messages"] = [userMessage("first question", 1)];
    const first = await run({ messages, tools }, {}, astra);
    // Sources reach the visible reply; the server keeps only the provider prose.
    expect(first.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: "searched answer\n\n[source](https://example.test/source)",
      }),
    );
    messages.push(first, userMessage("second question", 2));
    const second = await run({ messages, tools }, { reasoningEffort: "high" }, astra);
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
    const third = await run({ messages, tools }, { reasoningEffort: "high" }, astra);

    expect(third.stopReason).toBe("stop");
    expect(sseState.requests[1]).toMatchObject({
      previous_response_id: "resp_search",
      reasoning: { effort: "low" },
      input: [configuration("high"), wireUser("second question")],
    });
    expect(sseState.requests[2]).toMatchObject({
      previous_response_id: "resp_tool",
      reasoning: { effort: "low" },
      input: [lookupOutput],
    });
    expect(sseState.requests[2]?.input).toHaveLength(1);
  });

  it("never engages for a custom endpoint without the explicit opt-in, even with store:true forced (the host carries no trust signal on its own)", async () => {
    queueAnswers(2);
    await firstTwoTurns({}, unoptedCustomEndpointModel, {});

    expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
    expect(sseState.requests[1]?.input).toHaveLength(3);
  });

  it.each([{ transport: "websocket-cached", reset: "expiry" }] as const)(
    "preserves effort controls through $transport $reset and transcript reload",
    async ({ transport }) => {
      vi.useFakeTimers();
      queueAnswers();
      const options = { onPayload: noStore, transport };
      const { messages, first, second } = await firstTwoTurns(options, astra);
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
      expect(sseState.requests[1]).toMatchObject({ reasoning: { effort: "low" } });
      expect(sseState.requests[1]?.input).toContainEqual(configuration("high"));
      expect(sseState.requests[2]).toMatchObject({
        reasoning: { effort: "low", summary: "auto" },
        input: [
          { role: "user", content: [{ text: "first question" }] },
          { role: "assistant", content: [{ text: "first answer" }] },
          configuration("high"),
          { role: "user", content: [{ text: "second question" }] },
          { role: "assistant", content: [{ text: "second answer" }] },
          configuration("medium"),
          { role: "user", content: [{ text: "third question" }] },
        ],
      });
      expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
      expect(sseState.requests[1]).toHaveProperty("previous_response_id", "resp_1");
      expect(sseState.requests[2]).toHaveProperty("type", "response.create");
    },
  );

  it("round-trips reasoning state through the SQLite session transcript", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_warm", "third answer"),
      sdkCompletion("resp_reloaded", "third answer"),
    );
    const { messages } = await firstTwoTurns({ onPayload: noStore }, astra);
    expect(sseState.requests[1]?.input).toContainEqual(configuration("high"));
    const options = {
      onPayload: noStore,
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
      configuration("high"),
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      configuration("medium"),
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
    queueAnswers();
    let { messages } = await firstTwoTurns({ onPayload: noStore }, astra);
    expect(sseState.requests[1]?.input).toContainEqual(configuration("high"));
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
          ...noStore(payload),
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
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...asyncCall, arguments: "" },
          };
          yield { type: "response.output_item.done", output_index: 0, item: asyncCall };
          await withTestTimeout(toolStarted.promise, 5000, "Async tool did not start during SSE");
          const completed = completedEvent("resp_async", "independent answer");
          yield {
            type: "response.output_item.done",
            output_index: 1,
            item: completed.response.output[0],
          };
          responseCompleted.resolve();
          yield {
            ...completed,
            response: { ...completed.response, output: [asyncCall, ...completed.response.output] },
          };
        })(),
      },
      sdkUncitedCompletion("resp_final", "used lookup result"),
    );
    const agent = toolAgent(execute, "sessions_yield");
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
      expect(execute).toHaveBeenCalledTimes(1);
      expectToolResult(agent);
      expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
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
    sseState.outcomes.push(toolEvents(), sdkUncitedCompletion("resp_final", "used lookup result"));
    // plugins is synchronous but cannot collect async results (cron surfaces lack sessions_yield).
    const agent = toolAgent(execute, "plugins");
    await agent.prompt("Look it up and report.");
    expect(sseState.requests[0]?.tools).not.toContainEqual(
      expect.objectContaining({ async: true }),
    );
    expectToolResult(agent);
  });

  it.each([
    { name: "code mode", codeMode: true },
    { name: "API multi-agent", multiAgent: true },
  ])(
    "gates async advertisement and normalized calls for $name",
    async ({ codeMode, multiAgent }) => {
      sseState.outcomes.push(toolEvents(asyncCall));
      const result = await run(
        { messages: [userMessage("call", 1)], tools: [functionTool("exec"), functionTool("wait")] },
        {
          asyncToolExecution: true,
          openclawCodeModeToolSurface: codeMode,
          onPayload: (payload) => ({
            ...payload,
            ...(multiAgent ? { multi_agent: { enabled: true } } : {}),
          }),
        },
        astra,
      );
      expect(result.stopReason).toBe("toolUse");
      const tools = sseState.requests[0]?.tools as Array<{ async?: boolean }>;
      expect(tools.every((tool) => tool.async === undefined)).toBe(true);
      expect(result.content.find((item) => item.type === "toolCall")?.async).toBeUndefined();
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
      const { messages, second } = await firstTwoTurns({}, model, {});
      expect(second.stopReason).toBe("stop");
      await run({ messages });

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
    const withCompaction = (payload: Record<string, unknown>) => ({
      ...payload,
      store: true,
      input: [
        ...((payload.input as unknown[]) ?? []),
        { type: "compaction", encrypted_content: "opaque" },
      ],
    });
    const { messages } = await firstTwoTurns({}, model, { onPayload: withCompaction });
    await run({ messages });

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
    const sessionId = `session-${failure}`;
    await run(
      { messages: [userMessage("first", 1)], tools: [] },
      {
        sessionId,
        signal: failure === "abort" ? controller.signal : undefined,
      },
    );
    await run({ messages: [userMessage("next", 2)], tools: [] }, { sessionId });

    expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
  });
});
