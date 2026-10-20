import type { AssistantMessageEventStreamLike, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recoverAfterTransportDrop } from "../../../../src/agents/embedded-agent-runner/run/attempt-recovery.test-support.js";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { isResponsesOutputLimitToolCallError } from "../providers/openai-responses-terminal-usage.js";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sseState = vi.hoisted(() => ({
  outcomes: [] as SdkResponse[],
  signal: undefined as AbortSignal | undefined,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: (_params: unknown, options?: { signal?: AbortSignal }) => {
        sseState.signal = options?.signal;
        return {
          withResponse: async () => {
            const outcome = sseState.outcomes.shift();
            if (!outcome) {
              throw new Error("Unexpected SSE request");
            }
            return outcome;
          },
        };
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("terminal error tests must not construct a WebSocket");
  },
}));

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
import {
  argumentDelta,
  completedResponse,
  collectEventTypes,
  outputItem,
  wireCall,
} from "./openai-stream-cases.test-support.js";

const model = createModel({ id: "test-responses" });
const tokenUsage = { input_tokens: 20, output_tokens: 9, total_tokens: 29 };

const initialHost = getAiTransportHost();
const logWarn = vi.fn();
const logDebug = vi.fn<typeof initialHost.logDebug>();
const logInfo = vi.fn<typeof initialHost.logInfo>();

function queueStream(events: () => AsyncIterable<unknown>) {
  sseState.outcomes.push({ data: events(), response: new Response(null, { status: 200 }) });
}

function queueEvents(...events: unknown[]) {
  queueStream(async function* () {
    yield* events;
  });
}

function run(options: SimpleStreamOptions & OpenAIResponsesOptions = {}) {
  return createOpenAIResponsesTransportStreamFn()(
    model,
    { messages: [], tools: [] },
    { apiKey: "test-key", transport: "sse", ...options },
  );
}

async function collect(stream: AssistantMessageEventStreamLike) {
  return { events: await collectEventTypes(stream), result: await stream.result() };
}

function terminalDiagnostic(details: Record<string, unknown>) {
  return {
    type: "openai_responses_terminal",
    timestamp: expect.any(Number),
    details: { eventType: "response.incomplete", endTurn: "absent", ...details },
  };
}

function terminalEvent(
  id: string,
  reason: string | undefined,
  fields: Record<string, unknown> = {},
  type = "response.incomplete",
) {
  return { type, response: { id, incomplete_details: { reason }, ...fields } };
}

function probe(id: string, args = "", status = "in_progress") {
  return { ...wireCall(id, "probe", args), status };
}
beforeEach(() => {
  for (const log of [logWarn, logDebug, logInfo]) {
    log.mockClear();
  }
  for (const suffix of ["MODEL_TRANSPORT", "MODEL_PAYLOAD", "SSE", "CODE_MODE"]) {
    vi.stubEnv(`OPENCLAW_DEBUG_${suffix}`, undefined);
  }
  configureAiTransportHost({ logWarn, logDebug, logInfo });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  sseState.signal = undefined;
  configureAiTransportHost(initialHost);
});

it("aborts whitespace argument churn and recovers through the same-model retry owner", async () => {
  let emittedDeltas = 0;
  let closed = false;
  const call = wireCall("churn", "exec", "");
  queueStream(async function* () {
    try {
      yield outputItem("added", call);
      yield argumentDelta(call.id, '{"code":"return 1;');
      for (let index = 0; index < 40; index++) {
        emittedDeltas += 1;
        yield argumentDelta(call.id, " \r\r\n".repeat(256));
      }
      yield completedResponse("resp_churn", [{ ...call, arguments: '{"code":"return 1;"}' }]);
    } finally {
      closed = true;
    }
  });

  const { events, result } = await collect(await run());
  expect(result).toMatchObject({ stopReason: "error", errorCode: "degenerate_output" });
  expect(emittedDeltas).toBe(32);
  expect(closed).toBe(true);
  expect(sseState.signal).toMatchObject({
    aborted: true,
    reason: { code: "degenerate_output" },
  });
  expect(events).not.toContain("toolcall_end");
  expect(logWarn).toHaveBeenCalledWith(
    "openai-transport",
    expect.stringContaining("abortReason=degenerate_output"),
    undefined,
  );
  expect(JSON.stringify(logWarn.mock.calls)).not.toContain("return 1;");

  vi.useFakeTimers();
  const recovering = recoverAfterTransportDrop({
    assistant: result,
    noTools: true,
    replaySafe: true,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  const recovered = await recovering;
  expect(recovered.recovery).toMatchObject({
    action: "retry",
    lastRetryFailoverReason: "server_error",
  });
  expect(recovered.onAgentEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      stream: "run_status",
      data: expect.objectContaining({ phase: "retrying", retryAttempt: 1 }),
    }),
  );
  vi.useRealTimers();
  const retryCall = wireCall("retry", "exec", '{"code":"return 1;"}');
  queueEvents(outputItem("added", retryCall), completedResponse("resp_retry", [retryCall]));
  expect((await collect(await run())).result).toMatchObject({
    stopReason: "toolUse",
    content: [{ type: "toolCall", arguments: { code: "return 1;" } }],
  });
});

it("accepts 200 KiB of arguments with whitespace runs interrupted by code", async () => {
  const call = wireCall("large", "exec", "");
  const codeChunk = `${" ".repeat(1023)};`;
  const code = codeChunk.repeat(200);
  const args = JSON.stringify({ code });
  queueStream(async function* () {
    yield outputItem("added", call);
    yield argumentDelta(call.id, '{"code":"');
    for (let index = 0; index < 200; index++) {
      yield argumentDelta(call.id, codeChunk);
    }
    yield argumentDelta(call.id, '"}');
    yield completedResponse("resp_large", [{ ...call, arguments: args }]);
  });
  const { result } = await collect(await run());
  expect(result).toMatchObject({
    stopReason: "toolUse",
    content: [{ type: "toolCall", arguments: { code } }],
  });
  expect(sseState.signal?.aborted).toBe(false);
});

it("logs the actual output budget, served tier, and usage after a long incomplete stream", async () => {
  vi.stubEnv("OPENCLAW_DEBUG_SSE", "peek");
  let now = 1_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  queueStream(async function* () {
    yield { type: "response.created", response: { id: "resp_long", service_tier: "default" } };
    yield {
      type: "response.output_text.delta",
      delta: "private-response-content",
      output_index: 0,
      content_index: 0,
      item_id: "msg_private",
    };
    now += 1_095_000;
    yield terminalEvent("resp_long", "max_output_tokens", {
      status: "incomplete",
      service_tier: "default",
      output: [],
      usage: {
        input_tokens: 20,
        output_tokens: 4096,
        total_tokens: 4116,
        output_tokens_details: { reasoning_tokens: 4000 },
      },
    });
  });
  try {
    const stream = await run({ maxTokens: 4096, serviceTier: "priority" });
    expect((await stream.result()).stopReason).toBe("length");
    const messages = [
      ...logDebug.mock.calls.map(([, build]) => build()?.message),
      ...logInfo.mock.calls.map(([, message]) => message),
    ];
    const done = messages.find((message) => message?.startsWith("[responses] stream_done "));
    expect(done).toContain("requestedTier=priority max_output_tokens=4096");
    expect(done).toContain("responseId=resp_long servedTier=default");
    expect(done).toContain("outputTokens=4096 reasoningTokens=4000");
    expect(done).toContain("streamDurationMs=1095000 elapsedMs=1095000");
    expect(done).toContain("terminal=response.incomplete incompleteReason=max_output_tokens");
    expect(done).not.toContain("test-key");
    expect(messages.join(" ")).not.toContain("private-response-content");
  } finally {
    clock.mockRestore();
  }
});

it.each(["filtered", "failed", "eof", "aborted"])(
  "fences later tool completions after truncated output until %s",
  async (ending) => {
    const controller = new AbortController();
    const calls = ['{"token":"unfinished', '{"token":"complete"}'].map((args, index) =>
      Object.assign(probe(`parallel_${index}`, args, "completed"), { async: true }),
    );
    queueStream(async function* () {
      for (const [output_index, item] of calls.entries()) {
        yield outputItem("added", { ...item, arguments: "", status: "in_progress" }, output_index);
      }
      for (const [output_index, item] of calls.entries()) {
        yield outputItem("done", item, output_index);
      }
      if (ending === "aborted") {
        controller.abort(
          Object.assign(new Error("superseded"), {
            name: "AbortError",
            code: "AGENT_RUN_SUPERSEDED_ABORT",
          }),
        );
      }
      if (ending === "eof" || ending === "aborted") {
        return;
      }
      const status = ending === "filtered" ? "incomplete" : ending;
      yield terminalEvent(
        "resp_parallel_truncated",
        ending === "filtered" ? "content_filter" : "max_output_tokens",
        {
          model: "served-model",
          status,
          error: ending === "failed" ? { code: "server_error", message: "provider failed" } : null,
          output: calls,
          usage: tokenUsage,
        },
        `response.${status}`,
      );
    });
    const { events, result } = await collect(
      await run({ asyncToolExecution: true, signal: controller.signal }),
    );
    expect(events).not.toContain("toolcall_end");
    expect(events.filter((type) => type === "done" || type === "error")).toEqual(["error"]);
    expect(result.stopReason).toBe(ending === "aborted" ? "aborted" : "error");
    if (ending === "aborted") {
      expect(logWarn).not.toHaveBeenCalled();
      expect(
        logDebug.mock.calls.some(
          ([subsystem, build]) =>
            subsystem === "openai-transport" && build()?.message.startsWith("[responses] aborted "),
        ),
      ).toBe(true);
      expect(result.errorCode).toBe("AGENT_RUN_SUPERSEDED_ABORT");
    }
    if (ending !== "eof" && ending !== "aborted") {
      expect(result).toMatchObject({
        usage: { input: 20, output: 9, totalTokens: 29 },
        responseId: "resp_parallel_truncated",
        responseModel: "served-model",
      });
    }
    if (ending === "eof") {
      expect(result).toMatchObject({
        errorCode: "malformed_tool_call_arguments",
        errorMessage: "Responses stream completed tool call with invalid JSON arguments",
      });
      expect(JSON.parse(result.errorBody ?? "null")).toMatchObject({
        code: "malformed_tool_call_arguments",
        argumentChars: calls[0]?.arguments.length,
        repairAttempted: false,
      });
    } else {
      expect(result.errorCode).not.toBe("incomplete_tool_call");
      expect(result.errorCode).not.toBe("malformed_tool_call_arguments");
    }
    if (ending === "filtered") {
      expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
    } else if (ending === "failed") {
      expect(result.errorMessage).toContain("provider failed");
    }
  },
);

it("logs the idle-timeout reason at warning level when the stream throws a generic abort", async () => {
  vi.useFakeTimers();
  queueStream(async function* () {
    yield { type: "response.created", response: { id: "resp_timeout", status: "in_progress" } };
    await new Promise<void>((resolve) => {
      sseState.signal?.addEventListener("abort", () => resolve());
    });
    throw new Error("Request was aborted");
  });
  const stream = await streamWithIdleTimeout(createOpenAIResponsesTransportStreamFn(), 50)(
    model,
    { messages: [], tools: [] },
    { apiKey: "test-key", transport: "sse", headers: { Authorization: "Bearer private-key" } },
  );
  const result = stream.result();
  await vi.advanceTimersByTimeAsync(50);
  expect((await result).stopReason).toBe("aborted");
  expect(logWarn).toHaveBeenCalledWith(
    "openai-transport",
    expect.stringContaining("abortReason=idle_timeout"),
    undefined,
  );
  const line = logWarn.mock.calls.find(([, message]) =>
    message.startsWith("[responses] error "),
  )?.[1];
  expect(line).toContain("abortReason=idle_timeout");
  expect(line).not.toContain("message=");
  expect(line).not.toContain("LLM idle timeout");
  expect(JSON.stringify(logWarn.mock.calls)).not.toContain("private-key");
});

it("omits provider error messages, headers, and bodies from transport logs", async () => {
  const privateText = "synthetic private prompt and tool result";
  queueStream(async function* () {
    yield { type: "response.created", response: { id: "resp_error", status: "in_progress" } };
    throw Object.assign(new SyntaxError(`${privateText}\n${"x".repeat(400)}`), {
      status: 503,
      code: "service_unavailable",
      headers: { Authorization: "Bearer private-key" },
      request: { body: "private-request" },
      response: { body: "private-response", headers: { "set-cookie": "private-cookie" } },
    });
  });
  expect((await (await run()).result()).stopReason).toBe("error");
  const line = logWarn.mock.calls.find(([, message]) =>
    message.startsWith("[responses] error "),
  )?.[1];
  expect(line).toContain("name=SyntaxError status=503 code=service_unavailable");
  expect(line).not.toContain("abortReason=");
  expect(line).not.toContain("message=");
  expect(line).not.toContain("\n");
  const logs = JSON.stringify(logWarn.mock.calls);
  expect(logs).not.toContain(privateText);
  expect(logs).not.toMatch(/private-(?:key|request|response|cookie)/u);
});

it.each([
  { status: "incomplete", itemDone: false },
  { status: "failed", itemDone: true },
  { status: "in_progress", itemDone: true },
  { status: undefined, itemDone: true },
])(
  "retains usage and only recovers coherent output limits (status: $status, item done: $itemDone)",
  async ({ status, itemDone }) => {
    const partialCall = probe("truncated", '{"token":"unfinished', "incomplete");
    const coherent = status === undefined || status === "incomplete";
    queueEvents(
      outputItem("added", { ...partialCall, arguments: "", status: "in_progress" }),
      argumentDelta(partialCall.id, partialCall.arguments),
      ...(itemDone ? [outputItem("done", partialCall)] : []),
      terminalEvent("resp_truncated", "max_output_tokens", {
        model: "served-model",
        ...(status === undefined ? {} : { status }),
        output: [partialCall],
        usage: {
          ...tokenUsage,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
    const { events, result } = await collect(await run());
    expect(events.filter((type) => type === "done" || type === "error")).toEqual(["error"]);
    expect(events).not.toContain("toolcall_end");
    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "incomplete_tool_call",
      responseId: "resp_truncated",
      responseModel: "served-model",
      usage: { input: 16, cacheRead: 4, output: 9, totalTokens: 29, reasoningTokens: 3 },
    });
    expect(isResponsesOutputLimitToolCallError(result)).toBe(coherent);
    expect(result.diagnostics).toContainEqual(
      terminalDiagnostic({
        stopReason: coherent ? "length" : status === "failed" ? "error" : "toolUse",
        incompleteReason: "max_output_tokens",
        incompleteToolCallId: "call_truncated|fc_truncated",
      }),
    );
  },
);

it.each([
  { reason: "content_filter", activeTool: false },
  { reason: "content_filter", activeTool: true },
  { reason: "provider-private-reason", activeTool: true },
  { reason: undefined, activeTool: false },
])(
  "preserves bounded incomplete diagnostics for $reason (active tool: $activeTool)",
  async ({ reason, activeTool }) => {
    queueEvents(
      ...(activeTool ? [outputItem("added", probe("filtered"))] : []),
      terminalEvent("resp_filtered", reason, { status: "incomplete" }),
    );
    const result = await (await run({ sessionId: "session-terminal-error" })).result();
    expect(result.stopReason).toBe(activeTool || reason === "content_filter" ? "error" : "length");
    expect(result.errorCode).toBe(
      activeTool && reason !== "content_filter" ? "incomplete_tool_call" : undefined,
    );
    const incompleteReason = reason === "content_filter" ? reason : "unknown";
    if (reason === "content_filter") {
      expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
    }
    expect(result.diagnostics).toContainEqual(
      terminalDiagnostic({
        stopReason: reason === "content_filter" ? "error" : "length",
        incompleteReason,
        ...(activeTool ? { incompleteToolCallId: "call_filtered|fc_filtered" } : {}),
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("provider-private-reason");
    if (result.stopReason === "error") {
      expect(logWarn).toHaveBeenCalledWith(
        "openai-transport",
        expect.stringContaining(`incompleteReason=${incompleteReason}`),
        undefined,
      );
      expect(JSON.stringify(logWarn.mock.calls)).not.toContain("provider-private-reason");
    }
  },
);
