// Thinking sanitization tests cover reasoning-block retention, stripping, and
// recovery behavior for provider transcripts and active assistant turns.
import type { AgentMessage, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../test-helpers/assistant-event-stream.test-support.js";
import { sparseAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { stripStaleThinkingSignaturesForCompactionReplay } from "../thinking-signatures.js";
import { collectStreamEvents as collect } from "./run/attempt-stream.test-helpers.js";
import {
  assessLastAssistantMessage,
  dropReasoningFromHistory,
  dropThinkingBlocks,
  stripInvalidThinkingSignatures,
  wrapAnthropicStreamWithRecovery,
} from "./thinking.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ContentCase = [name: string, before: unknown[], after: unknown[]];
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function assistant(content: unknown[], timestamp?: number) {
  return castAgentMessage({
    ...sparseAssistant(content),
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}
const user = (content: string) => castAgentMessage({ role: "user", content });
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string, thinkingSignature?: string) => ({
  type: "thinking",
  thinking: value,
  ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
});
const omitted = [text(OMITTED_ASSISTANT_REASONING_TEXT)];
function expectContent(messages: AgentMessage[], index: number, content: unknown[]) {
  expect(messages[index]).toHaveProperty("content", content);
}

describe("thinking-free history contract", () => {
  it.each([
    { name: "dropThinkingBlocks", drop: dropThinkingBlocks },
    { name: "dropReasoningFromHistory", drop: dropReasoningFromHistory },
  ])("$name returns the original reference when no thinking blocks are present", ({ drop }) => {
    const messages = [user("hello"), assistant([text("world")])];
    expect(drop(messages)).toBe(messages);
  });
});

describe("dropThinkingBlocks", () => {
  it("preserves a latest assistant turn even when all content blocks are thinking", () => {
    const messages = [assistant([thinking("internal-only")])];
    expect(dropThinkingBlocks(messages)).toBe(messages);
  });

  it.each<ContentCase>([
    ["mixed", [thinking("old"), text("old text")], [text("old text")]],
    ["thinking-only", [thinking("old", "sig_old")], omitted],
    ["redacted-only", [{ type: "redacted_thinking", data: "opaque" }], omitted],
  ])("strips an older %s turn while preserving the latest thinking", (_name, prior, expected) => {
    const messages = [
      user("first"),
      assistant(prior),
      user("second"),
      assistant([thinking("latest", "sig_latest"), text("latest text")]),
    ];
    const result = dropThinkingBlocks(messages);
    expectContent(result, 1, expected);
    expectContent(result, 3, [thinking("latest", "sig_latest"), text("latest text")]);
  });
});

const toolCall = { type: "toolCall", id: "call123456", name: "lookup", arguments: {} };
function toolTurn() {
  return [
    user("look up the answer"),
    assistant([thinking("call the tool"), toolCall]),
    castAgentMessage({
      role: "toolResult",
      toolCallId: "call123456",
      toolName: "lookup",
      content: "42",
    }),
  ];
}

describe("dropReasoningFromHistory", () => {
  it("uses omitted-reasoning text when a completed assistant turn is reasoning-only", () => {
    expectContent(
      dropReasoningFromHistory([user("first"), assistant([thinking("private")]), user("second")]),
      1,
      omitted,
    );
  });
  it("preserves reasoning for the active tool-call continuation after the latest user turn", () => {
    const messages = toolTurn();
    expect(dropReasoningFromHistory(messages)).toBe(messages);
  });
  it("strips reasoning from old tool-call turns once a later user turn starts", () => {
    const messages = [...toolTurn(), assistant([text("42")]), user("thanks")];
    expectContent(dropReasoningFromHistory(messages), 1, [toolCall]);
  });
});

const invalidThinking = () => [
  thinking("missing"),
  thinking("empty", ""),
  thinking("blank", "   "),
];
const signedAnswer = () => [thinking("signed", "sig"), text("answer")];
function olderTurn(content: unknown[]) {
  return [assistant(content), user("follow up"), assistant([text("latest")])];
}

describe("stripInvalidThinkingSignatures", () => {
  it("returns the original reference when no invalid thinking signatures are present", () => {
    const messages = [user("hello"), assistant([thinking("internal", "sig"), text("answer")])];
    expect(stripInvalidThinkingSignatures(messages)).toBe(messages);
  });
  it("preserves invalid thinking signatures on the latest assistant message", () => {
    const content = [...invalidThinking(), ...signedAnswer()];
    const messages = [user("hello"), assistant(content)];
    const result = stripInvalidThinkingSignatures(messages);
    expect(result).toBe(messages);
    expectContent(result, 1, [...invalidThinking(), ...signedAnswer()]);
  });
  it("can strip invalid thinking signatures from the latest assistant message", () => {
    const messages = [user("hello"), assistant([thinking("missing"), ...signedAnswer()])];
    const result = stripInvalidThinkingSignatures(messages, { preserveLatestAssistant: false });
    expect(result).not.toBe(messages);
    expectContent(result, 1, signedAnswer());
  });
  it.each<ContentCase>([
    [
      "missing, empty, and blank signatures",
      [...invalidThinking(), ...signedAnswer()],
      signedAnswer(),
    ],
    ["only invalid signatures", [thinking("reasoning", "")], omitted],
    [
      "invalid opaque signatures",
      [
        { type: "redacted_thinking", data: "" },
        { type: "redacted_thinking", signature: "   " },
        { type: "redacted_thinking", data: "opaque" },
        text("answer"),
      ],
      [{ type: "redacted_thinking", data: "opaque" }, text("answer")],
    ],
  ])("strips %s from older assistant messages", (_name, content, expected) => {
    const messages = olderTurn(content);
    const result = stripInvalidThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    expectContent(result, 0, expected);
  });
});

describe("assessLastAssistantMessage", () => {
  it.each([
    { text: "", assessment: "incomplete-text" },
    { text: "Here is my answ", assessment: "valid" },
    { text: { bad: true }, assessment: "incomplete-text" },
  ])("assesses signed thinking followed by $text as $assessment", ({ text: value, assessment }) => {
    expect(
      assessLastAssistantMessage(
        assistant([thinking("complete", "sig"), { type: "text", text: value }]),
      ),
    ).toBe(assessment);
  });
});

function invoke(wrapped: StreamFn, messages: AgentMessage[] = []) {
  return wrapped({} as never, { messages } as never, {} as never);
}
function invokeSync(wrapped: StreamFn) {
  const stream = invoke(wrapped);
  if (stream instanceof Promise) {
    throw new Error("Expected a synchronous event stream");
  }
  return stream;
}
describe("wrapAnthropicStreamWithRecovery", () => {
  const anthropicThinkingError = new Error(
    "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
  );
  const terminalThinkingSignatureError =
    "ValidationException: invalid signature on thinking block in message history";
  const genericizedProviderError =
    "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.";
  const history = () => [assistant([thinking("secret", "sig")])];
  function message(value = "recovered", errorMessage?: string) {
    return makeAgentAssistantMessage({
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: value }],
      stopReason: errorMessage ? "error" : "stop",
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
  type Event = Parameters<ReturnType<typeof createAssistantMessageEventStream>["push"]>[0];
  function stream(...events: Event[]) {
    return createQueuedAssistantStream((push) => {
      for (const event of events) {
        push({ ...event });
      }
    });
  }
  function done(result: AssistantMessage) {
    return stream({ type: "done", reason: "stop", message: result });
  }
  function failed(result: AssistantMessage) {
    return stream({ type: "error", reason: "error", error: result });
  }
  function harness(produce: (attempt: number) => ReturnType<StreamFn>, notify = false) {
    const inner = vi.fn<StreamFn>();
    inner.mockImplementation(() => produce(inner.mock.calls.length));
    const recovered = vi.fn();
    const wrapped = wrapAnthropicStreamWithRecovery(inner, {
      id: "test-session",
      ...(notify ? { onRecoveredAnthropicThinking: recovered } : {}),
    });
    return { inner, recovered, wrapped };
  }
  async function expectResult(
    response: Awaited<ReturnType<StreamFn>>,
    result: AssistantMessage,
    events?: Event[],
  ) {
    const actual = await collect(response);
    if (events) {
      expect(actual).toEqual(events);
    }
    await expect(response.result()).resolves.toEqual(result);
  }
  function expectRetryContent(inner: ReturnType<typeof harness>["inner"], content: unknown[]) {
    const retry = inner.mock.calls[1]?.[1].messages[0];
    expect(retry).toMatchObject({ role: "assistant" });
    expect(retry).toHaveProperty("content", content);
  }

  it.each([
    { name: "omitted reasoning", content: [], expected: omitted },
    { name: "visible text", content: [text("visible answer")], expected: [text("visible answer")] },
  ])("retries a rejected request once with $name", async ({ content, expected }) => {
    const { wrapped, inner } = harness(() => Promise.reject(anthropicThinkingError));
    await expect(
      invoke(wrapped, [assistant([thinking("secret", "sig"), ...content])]),
    ).rejects.toBe(anthropicThinkingError);
    expect(inner).toHaveBeenCalledTimes(2);
    expectRetryContent(inner, expected);
  });

  it("notifies recovery only after a rejected request retry succeeds", async () => {
    const result = message();
    const { wrapped, inner, recovered } = harness(
      (attempt) => (attempt === 1 ? Promise.reject(anthropicThinkingError) : done(result)),
      true,
    );
    await expectResult(
      await invoke(wrapped, [assistant([thinking("secret", "sig"), text("visible answer")])]),
      result,
    );
    expect(inner).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("does not notify recovery when the stripped-thinking retry also fails", async () => {
    const retryError = new Error("retry failed");
    const { wrapped, recovered } = harness(
      (attempt) => Promise.reject(attempt === 1 ? anthropicThinkingError : retryError),
      true,
    );
    await expect(invoke(wrapped, history())).rejects.toBe(retryError);
    expect(recovered).not.toHaveBeenCalled();
  });

  it("does not notify recovery when the stripped-thinking retry resolves to a stream error", async () => {
    const result = message("stream failed", "retry stream failed");
    const { wrapped, inner, recovered } = harness(
      (attempt) => (attempt === 1 ? Promise.reject(anthropicThinkingError) : failed(result)),
      true,
    );
    await expectResult(await invoke(wrapped, history()), result);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(recovered).not.toHaveBeenCalled();
  });

  it("retries Bedrock-style invalid thinking signature errors", async () => {
    const error = new Error(terminalThinkingSignatureError);
    const { wrapped, inner } = harness(() => Promise.reject(error));
    await expect(invoke(wrapped, [assistant([thinking("secret", "")])])).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["failover rawError", () => ({ rawError: terminalThinkingSignatureError })],
    [
      "Anthropic SDK error body",
      () => ({ error: { error: { message: terminalThinkingSignatureError } } }),
    ],
    ["direct errorMessage", () => ({ errorMessage: terminalThinkingSignatureError })],
    [
      "ProviderHttpError errorBody",
      () => ({
        errorBody: JSON.stringify({
          error: { message: terminalThinkingSignatureError, type: "invalid_request_error" },
        }),
      }),
    ],
    [
      "cyclic cause graph",
      () => {
        const cause = {
          cause: new Error(genericizedProviderError),
          message: terminalThinkingSignatureError,
        };
        const error = Object.assign(new Error(genericizedProviderError), { cause });
        cause.cause = error;
        return error;
      },
    ],
  ] as const)(
    "retries genericized request errors carrying provider detail in %s",
    async (_name, detail) => {
      const details = detail();
      const error =
        details instanceof Error
          ? details
          : Object.assign(new Error(genericizedProviderError), details);
      const { wrapped, inner } = harness(() => Promise.reject(error));
      await expect(invoke(wrapped)).rejects.toBe(error);
      expect(inner).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])("recovers terminal stream errors (promised=%s)", async (promised) => {
    const result = message();
    const { wrapped, inner } = harness((attempt) => {
      const response =
        attempt === 1
          ? failed(message("stream failed", terminalThinkingSignatureError))
          : done(result);
      return promised ? Promise.resolve(response) : response;
    });
    await expectResult(await invoke(wrapped, history()), result, [
      { type: "done", reason: "stop", message: result },
    ]);
    expect(inner).toHaveBeenCalledTimes(2);
    expectRetryContent(inner, omitted);
  });

  it("does not retry non-thinking terminal stream-error events", async () => {
    const result = message(terminalThinkingSignatureError, "rate limit exceeded");
    const { wrapped, inner } = harness(() => failed(result));
    await expectResult(invokeSync(wrapped), result, [
      { type: "error", reason: "error", error: result },
    ]);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not retry after output (promised=%s)", async (promised) => {
    const partial = message("");
    const result = message("stream failed", terminalThinkingSignatureError);
    const events: Event[] = [
      { type: "start", partial },
      { type: "error", reason: "error", error: result },
    ];
    const { wrapped, inner } = harness(() => {
      const response = stream(...events);
      return promised ? Promise.resolve(response) : response;
    });
    await expectResult(await invoke(wrapped), result, events);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the stream fails after yielding a chunk", async () => {
    const { wrapped, inner } = harness(
      () =>
        (async function* () {
          yield "chunk";
          throw anthropicThinkingError;
        })() as unknown as ReturnType<StreamFn>,
    );
    const response = invokeSync(wrapped);
    expect(await collect(response)).toEqual(["chunk"]);
    await expect(response.result()).rejects.toBe(anthropicThinkingError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-Anthropic-thinking errors", async () => {
    const error = new Error("rate limit exceeded");
    const { wrapped, inner } = harness(() => Promise.reject(error));
    await expect(invoke(wrapped)).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("allows each provider call to recover once", async () => {
    const { wrapped, inner } = harness(() => Promise.reject(anthropicThinkingError));
    const messages = history();
    await expect(invoke(wrapped, messages)).rejects.toBe(anthropicThinkingError);
    await expect(invoke(wrapped, messages)).rejects.toBe(anthropicThinkingError);
    expect(inner).toHaveBeenCalledTimes(4);
  });

  it("preserves result() for synchronous event streams", async () => {
    const result = message("done");
    const events: Event[] = [
      { type: "start", partial: result },
      { type: "done", reason: "stop", message: result },
    ];
    const { wrapped } = harness(() => stream(...events));
    await expectResult(invokeSync(wrapped), result, events);
  });

  it("recovers an error event from a Promise-resolved stream without changing Promise timing", async () => {
    const first = createDeferred<ReturnType<typeof createAssistantMessageEventStream>>();
    const result = message("recovered answer");
    const { wrapped, inner, recovered } = harness(
      (attempt) => (attempt === 1 ? first.promise : done(result)),
      true,
    );
    const responsePromise = invoke(wrapped);
    expect(responsePromise).toBeInstanceOf(Promise);
    let resolved = false;
    void Promise.resolve(responsePromise).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    const firstStream = createAssistantMessageEventStream();
    first.resolve(firstStream);
    const response = await responsePromise;
    queueMicrotask(() => {
      firstStream.push({
        type: "error",
        reason: "error",
        error: message("stream failed", terminalThinkingSignatureError),
      });
      firstStream.end();
    });
    await expectResult(response, result);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

function summary(timestamp: number | string = 2000) {
  return castAgentMessage({ role: "compactionSummary", summary: "s", tokensBefore: 0, timestamp });
}

describe("stripStaleThinkingSignaturesForCompactionReplay", () => {
  it.each([
    ["without a summary", () => [user("hello"), assistant([thinking("think", "sig")], 1000)]],
    ["without an assistant timestamp", () => [summary(), assistant([thinking("think", "sig")])]],
    [
      "at the summary timestamp",
      () => [summary(), assistant([thinking("exact", "exact_sig")], 2000)],
    ],
  ] as const)("preserves signatures %s", (_name, makeMessages) => {
    const messages = makeMessages();
    expect(stripStaleThinkingSignaturesForCompactionReplay(messages)).toBe(messages);
  });
  it("strips stale signatures before the newest summary, retaining later signatures", () => {
    const messages = [
      summary(),
      assistant(
        [
          thinking("old", "stale_sig"),
          { type: "redacted_thinking", data: "opaque_sig" },
          text("old answer"),
        ],
        1500,
      ),
      user("q"),
      summary(1000),
      assistant([thinking("new", "fresh_sig"), text("new answer")], 3000),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    expect(result).not.toBe(messages);
    expectContent(result, 1, [thinking("old"), { type: "redacted_thinking" }, text("old answer")]);
    expectContent(result, 4, [thinking("new", "fresh_sig"), text("new answer")]);
  });
  it("parses numeric-looking compaction strings as dates before numeric message timestamps", () => {
    const messages = [summary("2026"), assistant([thinking("old", "stale_sig")], 1_000_000)];
    expectContent(stripStaleThinkingSignaturesForCompactionReplay(messages), 1, [thinking("old")]);
  });
});
