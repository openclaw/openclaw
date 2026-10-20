import { describe, expect, it, vi } from "vitest";
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
  ) => {
    await run({
      appendMessage: async ({ message }) => {
        appended.push(message);
      },
    });
  },
}));

describe("importClaudeHistory", () => {
  it("omits metadata without changing other native conversation rows", async () => {
    const items = [
      parseMessage("user", "private skill instructions", { isMeta: true }),
      parseMessage("user", "run the review", { uuid: "operator-1" }),
      parseMessage("user", "compacted context", { isCompactSummary: true }),
      parseMessage("user", "transcript-only context", { isVisibleInTranscriptOnly: true }),
      parseMessage("assistant", "done"),
    ].filter((item) => item !== undefined);

    await importItems(items);

    expect(JSON.stringify(appended)).not.toContain("private skill instructions");
    expect(appended.find((message) => message.content === "run the review")?.provenance).toBe(
      undefined,
    );
    expect(appended.map((message) => message.content)).toEqual(
      expect.arrayContaining(["run the review", "compacted context", "transcript-only context"]),
    );
    expect(appended.find((message) => message.role === "assistant")).toBeDefined();
  });

  it("preserves Date.parse semantics for valid strings and falls back for invalid values", async () => {
    const fallbackTimestamp = new Date("2026-07-18T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(fallbackTimestamp);
    try {
      await importItems([
        { type: "userMessage", text: "invalid", timestamp: "not-a-date", uuid: "u-1" },
        { type: "userMessage", text: "numeric year", timestamp: "2026", uuid: "u-2" },
        { type: "userMessage", text: "numeric zero", timestamp: "0", uuid: "u-3" },
        {
          type: "userMessage",
          text: "pre-epoch",
          timestamp: "1969-12-31T23:59:59.000Z",
          uuid: "u-4",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }

    expect(appended).toHaveLength(4);
    expect(appended.map((message) => message.timestamp)).toEqual([
      -1_000,
      Date.parse("0"),
      Date.parse("2026"),
      fallbackTimestamp + 3,
    ]);
    expect(JSON.stringify(appended)).not.toContain('"timestamp":null');
  });

  it("tags imported native user rows so self-echo provenance excludes them", async () => {
    await importItems([
      { type: "userMessage", text: "continue", uuid: "u-1" },
      { type: "assistantMessage", text: "done", uuid: "a-1" },
    ]);

    const userRow = appended.find((message) => message.role === "user");
    // mirrorOrigin keeps imported native prompts out of ownRecentUserTexts; without
    // it a repeated external prompt like "continue" is swallowed as self-echo.
    expect(userRow?.["__openclaw"]).toMatchObject({ mirrorOrigin: "claude-catalog-import" });
    const assistantRow = appended.find((message) => message.role === "assistant");
    expect(assistantRow).toBeDefined();
    expect(assistantRow?.["__openclaw"]).toBeUndefined();
  });

  it("omits empty native reasoning records instead of rendering a placeholder", async () => {
    await importItems([
      { type: "reasoning", content: [{ type: "thinking", thinking: "" }], uuid: "r-1" },
      { type: "assistantMessage", text: "AUTH_OK", uuid: "a-1" },
    ]);

    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("AUTH_OK");
    expect(JSON.stringify(appended)).not.toContain("Unsupported Claude transcript item");
  });

  it("retains the placeholder for unsupported non-reasoning records", async () => {
    await importItems([{ type: "toolCall", content: [{ type: "tool_use" }], uuid: "t-1" }]);

    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("Unsupported Claude transcript item");
  });
});
