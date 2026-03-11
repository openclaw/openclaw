import type { PluginLogger } from "openclaw/plugin-sdk/byterover";
import { describe, it, expect, vi } from "vitest";
import { ByteRoverContextEngine } from "./context-engine.js";
import {
  serializeMessagesForCurate,
  extractTextContent,
  extractLatestUserQuery,
} from "./context-engine.js";

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// ByteRoverContextEngine — lifecycle shape
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine", () => {
  it("has correct info fields", () => {
    const engine = new ByteRoverContextEngine({}, makeLogger());
    expect(engine.info.id).toBe("byterover");
    expect(engine.info.name).toBe("ByteRover");
    expect(engine.info.ownsCompaction).toBe(false);
  });

  it("ingest returns { ingested: false }", async () => {
    const engine = new ByteRoverContextEngine({}, makeLogger());
    const result = await engine.ingest({
      sessionId: "s1",
      message: { role: "user", content: "hi" },
    });
    expect(result).toEqual({ ingested: false });
  });

  it("compact returns not-compacted", async () => {
    const engine = new ByteRoverContextEngine({}, makeLogger());
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
    });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
  });

  it("afterTurn skips heartbeat turns", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine({}, logger);
    await engine.afterTurn({
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
      isHeartbeat: true,
    });
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("heartbeat"));
  });

  it("afterTurn skips when no new messages", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine({}, logger);
    await engine.afterTurn({
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 1, // all messages are old
    });
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("no new messages"));
  });

  it("assemble returns messages pass-through when no prompt", async () => {
    const engine = new ByteRoverContextEngine({}, makeLogger());
    const messages = [{ role: "assistant", content: "hello" }] as unknown[];
    const result = await engine.assemble({
      sessionId: "s1",
      messages,
    });
    expect(result.messages).toBe(messages);
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("assemble skips brv query for trivially short prompts", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine({}, logger);
    const messages = [{ role: "user", content: "ok" }] as unknown[];
    const result = await engine.assemble({
      sessionId: "s1",
      messages,
      prompt: "ok",
    });
    expect(result.messages).toBe(messages);
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("query too short"));
  });

  it("assemble skips brv query for short prompts after metadata stripping", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine({}, logger);
    const messages = [] as unknown[];
    const prompt = [
      "Sender (untrusted metadata):",
      "```json",
      '{"name": "Alice"}',
      "```",
      "hi",
    ].join("\n");
    const result = await engine.assemble({
      sessionId: "s1",
      messages,
      prompt,
    });
    expect(result.systemPromptAddition).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("query too short"));
  });
});

// ---------------------------------------------------------------------------
// serializeMessagesForCurate
// ---------------------------------------------------------------------------

describe("serializeMessagesForCurate", () => {
  it("serializes user and assistant messages", () => {
    const messages = [
      { role: "user", content: "What is TypeScript?" },
      {
        role: "assistant",
        content: "<final>TypeScript is a typed superset of JavaScript.</final>",
      },
    ];
    const result = serializeMessagesForCurate(messages);
    expect(result).toContain("[user]: What is TypeScript?");
    expect(result).toContain("[assistant]: TypeScript is a typed superset of JavaScript.");
    // Tags should be stripped
    expect(result).not.toContain("<final>");
  });

  it("skips toolResult messages", () => {
    const messages = [
      { role: "user", content: "run the test" },
      { role: "toolResult", content: "test passed" },
      { role: "assistant", content: "Tests passed!" },
    ];
    const result = serializeMessagesForCurate(messages);
    expect(result).not.toContain("toolResult");
    expect(result).not.toContain("test passed");
  });

  it("skips messages with no role", () => {
    const messages = [{ content: "orphan" }, { role: "user", content: "hi" }];
    const result = serializeMessagesForCurate(messages);
    expect(result).not.toContain("orphan");
    expect(result).toContain("[user]: hi");
  });

  it("skips messages with empty content", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "assistant", content: "response" },
    ];
    const result = serializeMessagesForCurate(messages);
    expect(result).toBe("[assistant]: response");
  });

  it("extracts sender attribution from metadata", () => {
    const messages = [
      {
        role: "user",
        content: [
          "Sender (untrusted metadata):",
          "```json",
          '{"name": "Alice"}',
          "```",
          "How do hooks work?",
        ].join("\n"),
      },
    ];
    const result = serializeMessagesForCurate(messages);
    expect(result).toContain("[Alice]: How do hooks work?");
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
  it("returns string content directly", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("extracts text from ContentBlock array", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "image", url: "x" },
      { type: "text", text: "second" },
    ];
    expect(extractTextContent(blocks)).toBe("first\nsecond");
  });

  it("returns empty string for non-string/non-array", () => {
    expect(extractTextContent(42)).toBe("");
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractLatestUserQuery
// ---------------------------------------------------------------------------

describe("extractLatestUserQuery", () => {
  it("returns the last user message text", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ];
    expect(extractLatestUserQuery(messages)).toBe("second question");
  });

  it("strips metadata from user message", () => {
    const messages = [
      {
        role: "user",
        content: [
          "Sender (untrusted metadata):",
          "```json",
          '{"name": "X"}',
          "```",
          "actual query",
        ].join("\n"),
      },
    ];
    expect(extractLatestUserQuery(messages)).toBe("actual query");
  });

  it("returns null when no user messages exist", () => {
    const messages = [{ role: "assistant", content: "hi" }];
    expect(extractLatestUserQuery(messages)).toBeNull();
  });

  it("returns null when user message is metadata-only", () => {
    const messages = [
      {
        role: "user",
        content: ["Sender (untrusted metadata):", "```json", '{"name": "X"}', "```"].join("\n"),
      },
    ];
    expect(extractLatestUserQuery(messages)).toBeNull();
  });
});
