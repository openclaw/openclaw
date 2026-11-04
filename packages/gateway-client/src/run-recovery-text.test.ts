import { expect, it, vi } from "vitest";
import { recoverTerminalReply, type RecoveryRequest } from "./run-recovery-text.js";

const scope = { sessionKey: "agent:main:recovery", agentId: "main", sessionId: "session" };
const result = {
  terminalReply: { disposition: "visible", text: "A bounded summary…" },
  terminalReceipt: {
    runId: "run",
    sessionId: "session",
    assistantTranscriptIdempotencyKey: "answer-occurrence",
  },
};
const metadata = { id: "answer", idempotencyKey: "answer-occurrence" };
const assistant = (content: unknown, identity: Record<string, unknown> = metadata) => ({
  role: "assistant",
  content,
  __openclaw: identity,
});
const unrelated = assistant("another run", { runId: "other" });
const recover = (request: RecoveryRequest, terminal: unknown = result) =>
  recoverTerminalReply({
    runId: "run",
    scope,
    result: terminal,
    request,
    signal: new AbortController().signal,
  });

it.each(["answer", "other"])("requires the matching full occurrence (%s)", async (id) => {
  const outputText = "complete answer ".repeat(2_000).trim();
  const request = vi.fn<RecoveryRequest>(async (method, params) => {
    if (method === "chat.message.get") {
      expect(params).toEqual({
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
        messageId: "answer",
      });
      return { ok: true, message: assistant(outputText, { ...metadata, id }) };
    }
    expect(method).toBe("chat.history");
    return {
      sessionId: "session",
      messages:
        params.offset === 200
          ? [assistant("placeholder", { ...metadata, truncated: true })]
          : [unrelated],
      hasMore: params.offset === undefined,
      nextOffset: 200,
    };
  });
  await expect(recover(request)).resolves.toEqual(
    id === "answer" ? { outputText } : { unavailable: "full-message-unavailable" },
  );
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([
  ["First item", "Second item", "First item\n\nSecond item"],
  ["First item\n", "\nSecond item", "First item\n\nSecond item"],
  [" First item\n\n", "\nSecond item ", " First item\n\n\nSecond item "],
])("joins paged items at live display boundaries", async (first, second, outputText) => {
  const request = vi.fn<RecoveryRequest>(async (_method, params) => ({
    sessionId: "session",
    messages:
      params.offset === undefined
        ? [assistant(second, { ...metadata, runId: "run" })]
        : [unrelated, assistant(first, { id: "first", runId: "run" })],
    hasMore: params.offset === undefined,
    nextOffset: 200,
  }));
  await expect(recover(request)).resolves.toEqual({ outputText });
});

it.each<[string, unknown[], string, unknown?, number?]>([
  [
    "text block types and separators",
    [
      assistant([
        { type: "text", text: "First" },
        { type: "text", text: "  " },
        { type: "thinking", thinking: "hidden" },
        { type: "output_text", text: "Second" },
        { type: "input_text", text: "Third" },
        { type: "text", text: "\n" },
      ]),
    ],
    "First\n  \nSecond\nThird\n\n",
  ],
  [
    "commentary excluded from the final occurrence",
    [
      {
        ...assistant("Thinking aloud"),
        openclawStreamFallback: { source: "segment", itemId: "commentary" },
      },
      assistant("Answer"),
    ],
    "Answer",
  ],
  ["without receipt", [assistant("expected", { runId: "run" }), unrelated], "expected", {}],
  ["silent outcome", [], "", { terminalReply: { disposition: "silent" } }, 0],
])("preserves %s", async (_name, messages, outputText, terminal = result, reads = 1) => {
  const request = vi.fn<RecoveryRequest>(async () => ({ sessionId: "session", messages }));
  await expect(recover(request, terminal)).resolves.toEqual({ outputText });
  expect(request).toHaveBeenCalledTimes(reads);
});

it.each([
  ["session-changed", "replacement", [], false, 1],
  ["reply-not-found", "session", [unrelated], false, 1],
  ["history-limit-reached", "session", [assistant("tail")], true, 10],
] as const)("reports %s", async (reason, sessionId, messages, hasMore, reads) => {
  const request = vi.fn<RecoveryRequest>(async (_method, params) => ({
    sessionId,
    messages,
    hasMore,
    nextOffset: Number(params.offset ?? 0) + 200,
  }));
  await expect(recover(request)).resolves.toEqual({ unavailable: reason });
  expect(request).toHaveBeenCalledTimes(reads);
});
