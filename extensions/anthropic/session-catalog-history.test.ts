import { afterEach, expect, it, vi } from "vitest";
import { importClaudeHistory } from "./session-catalog-history.js";
import { parseTranscriptLine } from "./session-catalog-transcript.js";

const appended: Array<Record<string, unknown>> = [];
function importItems(items: Parameters<typeof importClaudeHistory>[0]["items"]) {
  appended.length = 0;
  return importClaudeHistory({
    items,
    threadId: "thread-1",
    storePath: "/tmp/sessions.json",
    sessionId: "session-1",
    sessionKey: "agent:main:catalog-adopt",
    agentId: "main",
    config: {},
  });
}

function parseMessage(role: string, content: string, flags: Record<string, unknown> = {}) {
  const row = { type: role, ...flags, message: { role, content } };
  return parseTranscriptLine(Buffer.from(JSON.stringify(row)));
}

// mock-isolation: Exercise native message projection without opening the transcript store.
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  withSessionTranscriptWrite: async (
    _params: unknown,
    run: (transcript: {
      appendMessage: (input: { message: Record<string, unknown> }) => Promise<void>;
    }) => Promise<void>,
  ) =>
    run({
      appendMessage: async ({ message }) => {
        appended.push(message);
      },
    }),
}));

afterEach(() => vi.useRealTimers());

it.each(["", "{", "null", "[]", "42", '"text"', "{}"])(
  "ignores malformed JSON and non-message transcript rows: %j",
  (line) => {
    expect(parseTranscriptLine(Buffer.from(line))).toBeUndefined();
  },
);

it("omits metadata without changing other native conversation rows", async () => {
  const items = [
    parseMessage("user", "private skill instructions", { isMeta: true, uuid: "meta-1" }),
    parseMessage("user", "run the review", { uuid: "operator-1" }),
    parseMessage("user", "compacted context", { isCompactSummary: true, uuid: "compact-1" }),
    parseMessage("user", "transcript-only context", {
      isVisibleInTranscriptOnly: true,
      uuid: "transcript-only-1",
    }),
    parseMessage("assistant", "done", { uuid: "assistant-1" }),
  ].filter((item) => item !== undefined);

  await importItems(items);

  expect(JSON.stringify(appended)).not.toContain("private skill instructions");
  // Imported prompts must not be swallowed as OpenClaw self-echoes.
  expect(appended).toMatchObject([
    { role: "assistant" },
    { content: "transcript-only context" },
    { content: "compacted context" },
    { content: "run the review", __openclaw: { mirrorOrigin: "claude-catalog-import" } },
  ]);
  expect(appended[3]?.provenance).toBeUndefined();
  expect(appended[0]?.["__openclaw"]).toBeUndefined();
});

it("rejects uuid-less rows instead of minting window-position identity", async () => {
  await expect(
    importItems([
      { type: "userMessage", text: "has a uuid", uuid: "stable-1" } as never,
      { type: "userMessage", text: "window position is not durable identity" } as never,
    ]),
  ).rejects.toThrow("no stable import uuid");
  expect(appended).toEqual([]);
});

it("derives idempotency keys from stable uuids across re-imports", async () => {
  const row = (uuid: string) => ({ type: "userMessage", text: `text ${uuid}`, uuid }) as never;
  await importItems([row("row-1"), row("row-2")]);
  expect(appended.map((message) => message.idempotencyKey)).toEqual([
    "claude-catalog:thread-1:row-2",
    "claude-catalog:thread-1:row-1",
  ]);

  // Recovery re-imports the grown window: shared rows keep their key regardless
  // of their position in the retained suffix, so the store can dedupe them.
  await importItems([row("row-2"), row("row-3")]);
  expect(appended.map((message) => message.idempotencyKey)).toEqual([
    "claude-catalog:thread-1:row-3",
    "claude-catalog:thread-1:row-2",
  ]);
});

it("keeps parsed timestamps and offsets invalid ones in import order", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  await importItems(
    ["not-a-date", "0"].map((timestamp, index) => ({
      type: "userMessage",
      text: timestamp,
      timestamp,
      uuid: `timestamped-${index}`,
    })) as never,
  );
  expect(appended.map((message) => message.timestamp)).toEqual([Date.parse("0"), 1_001]);
});

it.each([
  ["reasoning", []],
  ["toolCall", [[{ type: "text", text: "Tool call\n\n[Unsupported Claude transcript item]" }]]],
] as const)("projects empty %s records", async (type, content) => {
  await importItems([{ type, uuid: "empty-1" }] as never);
  expect(appended.map((message) => message.content)).toEqual(content);
});
