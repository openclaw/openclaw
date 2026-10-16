import path from "node:path";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { toToolDefinitions } from "../../../../src/agents/agent-tool-definition-adapter.js";
import { SessionManager } from "../../../../src/agents/sessions/session-manager.js";
import { wrapToolDefinition } from "../../../../src/agents/sessions/tools/tool-definition-wrapper.js";
import { createSessionsYieldTool } from "../../../../src/agents/tools/sessions-yield-tool.js";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../../../src/test-utils/session-state-cleanup.js";
import { createDeferred, withTestTimeout } from "../../../../test/helpers/promise.js";
import { Agent } from "../../../agent-core/src/agent.js";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sseState = vi.hoisted(() => ({
  clientHeaders: [] as Array<Record<string, string>>,
  outcomes: [] as Array<Error | SdkResponse>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    apiKey: string;
    baseURL: string;
    responses = {
      create: (request: Record<string, unknown>) => {
        sseState.requests.push(request);
        const outcome = sseState.outcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };

    constructor(options: {
      apiKey?: string;
      baseURL?: string;
      defaultHeaders?: Record<string, string>;
    }) {
      this.apiKey = options.apiKey ?? "";
      this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
      sseState.clientHeaders.push(options.defaultHeaders ?? {});
    }

    withOptions(options: { apiKey?: string }) {
      return new MockOpenAI({ apiKey: options.apiKey ?? this.apiKey, baseURL: this.baseURL });
    }
  }

  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
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
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
import {
  completedResponse,
  outputItem,
  userMessage,
  wireMessage,
  wireCall,
  wireUser,
} from "./openai-stream-cases.test-support.js";

const initialHost = getAiTransportHost();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-responses-transcript-");
const model = createModel({ id: "gpt-5.6-luna" });
const astra = { ...model, id: "gpt-6-astra", name: "GPT-6 Astra" };

function functionTool(name: string) {
  return { name, description: name, parameters: Type.Object({}) };
}

const asyncCall = { ...wireCall("lookup", "lookup"), status: "completed", async: true };

function completedEvent(responseId: string, content: string) {
  return completedResponse(responseId, [wireMessage(`msg_${responseId}`, content)], {
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  });
}

function sdkCompletion(responseId: string, content: string): SdkResponse {
  return sdkEvents(completedEvent(responseId, content));
}

function queueAnswers(count = 2) {
  sseState.outcomes.push(
    ...["first", "second", "third"]
      .slice(0, count)
      .map((word, index) => sdkCompletion(`resp_${index + 1}`, `${word} answer`)),
  );
}

const stateful = (payload: Record<string, unknown>) => ({ ...payload, store: true });
const stateless = (payload: Record<string, unknown>) => ({ ...payload, store: false });
let firstUser = userMessage("first question", 1);
const configuration = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

async function reasoningHistory(transport: "sse" | "websocket-cached" = "sse") {
  const options = { onPayload: stateless, transport };
  const messages: Context["messages"] = [firstUser];
  const first = await run(messages, options, astra);
  messages.push(first, userMessage("second question", 2));
  const second = await run(messages, { ...options, reasoningEffort: "high" }, astra);
  messages.push(second, userMessage("third question", 3));
  expect(sseState.requests[1]?.input).toContainEqual(configuration("high"));
  return { messages, first, second };
}

function sdkEvents(...events: Array<Record<string, unknown>>): SdkResponse {
  return sdkStream(async function* () {
    yield* events;
  });
}

function sdkStream(data: () => AsyncIterable<unknown>): SdkResponse {
  return { data: data(), response: new Response(null, { status: 200 }) };
}

const unoptedCustomEndpointModel = {
  ...model,
  provider: "omniroute",
  baseUrl: "https://omniroute.example.com/v1",
} satisfies Model<"openai-responses">;

async function run(
  messages: Context["messages"],
  options: Omit<OpenAIResponsesOptions, "onPayload"> & {
    onPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  },
  requestModel: Model = model,
  tools: Context["tools"] = [],
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(requestModel, { messages, tools }, {
    ...options,
    apiKey: "test-key",
    sessionId: options.sessionId ?? "session-1",
    transport: options.transport ?? "sse",
    reasoningEffort: options.reasoningEffort ?? "low",
  } as never);
  return stream.result();
}

beforeEach(() => {
  firstUser = userMessage("first question", 1);
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

afterEach(() => {
  cleanupSessionResources();
  configureAiTransportHost(initialHost);
  vi.useRealTimers();
});

it.each(["native", "custom"] as const)(
  "only continues opted-in %s SSE turns with matching affinity",
  async (endpoint) => {
    queueAnswers();
    const native = endpoint === "native";
    const requestModel = native
      ? { ...model, compat: { sendSessionIdHeader: true } }
      : unoptedCustomEndpointModel;
    const options = {
      onPayload: stateful,
      ...(native ? { cacheRetention: "short" as const } : {}),
    };
    const first = await run([firstUser], options, requestModel);
    const second = await run(
      [firstUser, first, userMessage("second question", 2)],
      options,
      requestModel,
    );

    expect(second.stopReason).toBe("stop");
    if (native) {
      expect(sseState.clientHeaders).toMatchObject([
        { "x-openclaw-turn-id": "turn-1", session_id: "session-1" },
        { "x-openclaw-turn-id": "turn-2", session_id: "session-1" },
      ]);
      expect(sseState.requests[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [wireUser("second question")],
      });
    } else {
      expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
      expect(sseState.requests[1]?.input).toHaveLength(3);
    }
  },
);

it("preserves effort controls through websocket-cached expiry and transcript reload", async () => {
  vi.useFakeTimers();
  queueAnswers(3);
  const options = { onPayload: stateless, transport: "websocket-cached" as const };
  const { messages, first, second } = await reasoningHistory(options.transport);
  vi.advanceTimersByTime(5 * 60 * 1000 + 1);
  const serialized = JSON.stringify(messages);
  const third = await run(JSON.parse(serialized), { ...options, reasoningEffort: "medium" }, astra);
  expect([first, second, third].map(({ stopReason }) => stopReason)).toEqual([
    "stop",
    "stop",
    "stop",
  ]);
  expect(sseState.requests[1]).toMatchObject({ reasoning: { effort: "low" } });
  expect(sseState.requests[2]).toMatchObject({
    type: "response.create",
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
});

it("round-trips reasoning state through the SQLite session transcript", async () => {
  configureAiTransportHost({
    ...initialHost,
    plugin: { ...initialHost.plugin, resolveTransportTurnState: () => undefined },
  });
  queueAnswers();
  sseState.outcomes.push(
    sdkCompletion("resp_warm", "third answer"),
    sdkCompletion("resp_reloaded", "third answer"),
  );
  const { messages } = await reasoningHistory();
  const options = {
    onPayload: stateless,
    reasoningEffort: "medium" as const,
    sessionId: "session-1",
  };
  expect((await run(messages, options, astra)).stopReason).toBe("stop");
  const expectedRequest = sseState.requests.at(-1);
  expect(expectedRequest).toMatchObject({ reasoning: { effort: "low" } });
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
  expect((await run(requestMessages, options, astra)).stopReason).toBe("stop");
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
  queueAnswers(3);
  let { messages } = await reasoningHistory();
  cleanupSessionResources();
  if (change === "compacted history") {
    messages = [userMessage("compacted summary", 0), ...messages.slice(3)];
  } else if (change === "edited history") {
    messages[0] = userMessage("edited question", 1);
  }
  const serialized = JSON.stringify(messages);
  const third = await run(
    JSON.parse(serialized),
    {
      reasoningEffort: "medium",
      onPayload: (payload) => ({
        ...stateless(payload),
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
    sdkStream(async function* () {
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
    }),
    sdkCompletion("resp_final", "used lookup result"),
  );
  const agent = new Agent({
    initialState: {
      model: astra,
      thinkingLevel: "low",
      tools: [{ ...functionTool("lookup"), label: "lookup", execute }],
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

it.each([
  { name: "code mode", codeMode: true },
  { name: "API multi-agent", multiAgent: true },
])("gates async advertisement and normalized calls for $name", async ({ codeMode, multiAgent }) => {
  const completed = completedEvent("resp_call", "");
  sseState.outcomes.push(
    sdkEvents(outputItem("added", { ...asyncCall, arguments: "" }), outputItem("done", asyncCall), {
      ...completed,
      response: { ...completed.response, output: [asyncCall] },
    }),
  );
  const result = await run(
    [userMessage("call", 1)],
    {
      asyncToolExecution: true,
      openclawCodeModeToolSurface: codeMode,
      onPayload: (payload) => ({
        ...payload,
        ...(multiAgent ? { multi_agent: { enabled: true } } : {}),
      }),
    },
    astra,
    [functionTool("exec"), functionTool("wait")],
  );
  expect(result.stopReason).toBe("toolUse");
  const tools = sseState.requests[0]?.tools as Array<{ async?: boolean }>;
  expect(tools.every((tool) => tool.async === undefined)).toBe(true);
  expect(result.content.find((item) => item.type === "toolCall")?.async).toBeUndefined();
});

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
    [userMessage("wait", 1)],
    { asyncToolExecution: true, onPayload: (payload) => payload },
    astra,
    sessionTools,
  );
  expect(sseState.requests[0]?.tools).toEqual([
    expect.objectContaining({ name: "exec", async: true }),
    expect.objectContaining({ name: "sessions_yield" }),
  ]);
  expect(sseState.requests[0]?.tools).not.toContainEqual(
    expect.objectContaining({ name: "sessions_yield", async: true }),
  );
});

it.each(["continuation", "compaction"])(
  "records effective full-history recovery after rejected %s",
  async (mode) => {
    const compaction = mode === "compaction";
    const error = compaction
      ? Object.assign(new Error("invalid encrypted content"), {
          code: "invalid_encrypted_content",
        })
      : Object.assign(
          new Error(
            "400 Previous response cannot be used for this organization due to Zero Data Retention.",
          ),
          { code: "unsupported_parameter", param: "previous_response_id", status: 400 },
        );
    queueAnswers(3);
    sseState.outcomes.splice(1, 0, error);
    const onPayload = (payload: Record<string, unknown>) => ({
      ...stateful(payload),
      ...(compaction
        ? {
            input: [
              ...((payload.input as unknown[]) ?? []),
              { type: "compaction", encrypted_content: "opaque" },
            ],
          }
        : {}),
    });
    const messages: Context["messages"] = [firstUser];
    messages.push(await run(messages, { onPayload: stateful }), userMessage("second question", 2));
    const second = await run(messages, { onPayload });
    expect(second.stopReason).toBe("stop");
    await run([...messages, second, userMessage("third question", 3)], { onPayload: stateful });

    expect(sseState.requests).toHaveLength(4);
    expect(sseState.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
    expect(sseState.requests[3]).toMatchObject({ previous_response_id: "resp_2" });
    if (compaction) {
      expect(JSON.stringify(sseState.requests[1]?.input)).toContain('"compaction"');
      expect(JSON.stringify(sseState.requests[2]?.input)).not.toContain('"compaction"');
    } else {
      expect(sseState.requests[1]?.input).toHaveLength(1);
      expect(sseState.requests[2]?.input).toHaveLength(3);
      expect(sseState.requests[3]?.input).toHaveLength(1);
    }
  },
);

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
    sseState.outcomes.push(
      sdkStream(async function* () {
        controller.abort();
        yield completedEvent("resp_aborted", "ignored");
      }),
    );
  }
  sseState.outcomes.push(sdkCompletion("resp_next", "next answer"));
  const onPayload = stateful;
  const sessionId = `session-${failure}`;
  await run([userMessage("first", 1)], {
    onPayload,
    sessionId,
    signal: failure === "abort" ? controller.signal : undefined,
  });
  await run([userMessage("next", 2)], { onPayload, sessionId });

  expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
});
