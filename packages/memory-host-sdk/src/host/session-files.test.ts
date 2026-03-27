import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js";

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-entry-test-"));
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("listSessionFilesForAgent", () => {
  it("includes reset and deleted transcripts in session file listing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(sessionsDir, "archive"), { recursive: true });

    const included = [
      "active.jsonl",
      "active.jsonl.reset.2026-02-16T22-26-33.000Z",
      "active.jsonl.deleted.2026-02-16T22-27-33.000Z",
    ];
    const excluded = ["active.jsonl.bak.2026-02-16T22-28-33.000Z", "sessions.json", "notes.md"];

    for (const fileName of [...included, ...excluded]) {
      await fs.writeFile(path.join(sessionsDir, fileName), "");
    }
    await fs.writeFile(
      path.join(sessionsDir, "archive", "nested.jsonl.deleted.2026-02-16T22-29-33.000Z"),
      "",
    );

    const files = await listSessionFilesForAgent("main");

    expect(files.map((filePath) => path.basename(filePath)).toSorted()).toEqual(
      included.toSorted(),
    );
  });
});

// Helpers for constructing inbound metadata blocks (mirrors format in inbound-meta.ts)
function makeConvBlock(extra: Record<string, string> = {}): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ message_id: "msg-1", sender: "TestUser", ...extra }, null, 2),
    "```",
  ].join("\n");
}

function makeUserMessageLine(content: string): string {
  return JSON.stringify({ type: "message", message: { role: "user", content } });
}

describe("buildSessionEntry", () => {
  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real session JSONL file with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "custom", customType: "openclaw.cache-ttl", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello world" } }),
      JSON.stringify({ type: "custom", customType: "tool-result", data: {} }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Tell me a joke" } }),
    ];
    const filePath = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The content should have 3 lines (3 message records)
    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry!.lineMap).toBeDefined();
    expect(entry!.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
  });

  it("skips blank lines and invalid JSON without breaking lineMap", async () => {
    const jsonlLines = [
      "",
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "First" } }),
      "",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Second" } }),
    ];
    const filePath = path.join(tmpDir, "gaps.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([3, 5]);
  });

  it("strips 'Conversation info (untrusted metadata):' block from indexed text", async () => {
    // User message with prepended OpenClaw inbound metadata block
    const userContent = [makeConvBlock(), "", "What is the weather today?"].join("\n");
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "meta-conv.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(1);
    // Metadata JSON should not appear in the indexed text
    expect(entry!.content).not.toContain("Conversation info");
    expect(entry!.content).not.toContain("untrusted metadata");
    expect(entry!.content).not.toContain("message_id");
    // The actual user message should be preserved
    expect(entry!.content).toContain("What is the weather today?");
  });

  it("strips [[reply_to_current]] inline directive tags from indexed text", async () => {
    // User message containing an inline reply directive tag
    const userContent = "[[reply_to_current]] Can you explain that again?";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "reply-tag.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The [[reply_to_current]] tag should be stripped
    expect(entry!.content).not.toContain("[[reply_to_current]]");
    // The actual message text should be preserved
    expect(entry!.content).toContain("Can you explain that again?");
  });

  it("strips metadata from array-of-parts content (structured message form)", async () => {
    // User message where content is an array of text parts (e.g. multi-modal messages)
    const metaBlock = makeConvBlock();
    const arrayContent = [
      { type: "text", text: `${metaBlock}\n\nWhat time is the meeting?` },
      { type: "text", text: "[[reply_to_current]] Also, who is attending?" },
    ];
    const jsonlLines = [
      JSON.stringify({ type: "message", message: { role: "user", content: arrayContent } }),
    ];
    const filePath = path.join(tmpDir, "array-content.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // Metadata JSON block should not appear in the indexed text
    expect(entry!.content).not.toContain("Conversation info");
    expect(entry!.content).not.toContain("untrusted metadata");
    expect(entry!.content).not.toContain("message_id");
    // Inline directive tags should be stripped
    expect(entry!.content).not.toContain("[[reply_to_current]]");
    // The actual user messages should be preserved
    expect(entry!.content).toContain("What time is the meeting?");
    expect(entry!.content).toContain("Also, who is attending?");
  });

  it("preserves inline mentions of directive tags mid-text (not leading)", async () => {
    // When a user discusses directive tags inline (e.g. troubleshooting docs),
    // those mentions should NOT be stripped — only leading control-tag positions are removed.
    const userContent =
      "The [[reply_to_current]] tag is used for replies. You can also use [[reply_to:msg-123]].";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "inline-tags.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // Mid-text mentions should be preserved for searchability
    expect(entry!.content).toContain("[[reply_to_current]]");
    expect(entry!.content).toContain("[[reply_to:msg-123]]");
    expect(entry!.content).toContain("The [[reply_to_current]] tag is used for replies");
  });

  it("strips leading directive tags but preserves inline ones in same text", async () => {
    // Leading tag should be stripped, but inline mention later in text should remain
    const userContent =
      "[[reply_to_current]] Regarding the [[reply_to_current]] directive, how does it work?";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "mixed-tags.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The leading tag is stripped, but the inline one remains
    expect(entry!.content).toContain("[[reply_to_current]]");
    expect(entry!.content).toContain("Regarding the [[reply_to_current]] directive");
    // Should not start with the tag
    const userLine = entry!.content.split("\n")[0];
    expect(userLine).toMatch(/^User: Regarding/);
  });

  it("preserves normal message content without modification", async () => {
    // Plain user and assistant messages with no injected metadata
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Tell me about TypeScript generics." },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "TypeScript generics allow you to write reusable typed code.",
        },
      }),
    ];
    const filePath = path.join(tmpDir, "normal.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(2);
    expect(contentLines[0]).toContain("User: Tell me about TypeScript generics.");
    expect(contentLines[1]).toContain(
      "Assistant: TypeScript generics allow you to write reusable typed code.",
    );
  });

  it("strips DOW-prefixed timestamp envelope from indexed user text", async () => {
    // `injectTimestamp` produces "[Wed 2026-03-27 14:47 EDT] …"
    // The DOW abbreviation comes BEFORE the year, so the former "[20" sentinel
    // never matched this format.  The fast-path must use the regex instead.
    const userContent = "[Wed 2026-03-27 14:47 EDT] What is the status of the deployment?";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "dow-timestamp.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The timestamp envelope should be stripped from the index
    expect(entry!.content).not.toContain("[Wed 2026-03-27 14:47 EDT]");
    // The actual user message should be preserved
    expect(entry!.content).toContain("What is the status of the deployment?");
    const userLine = entry!.content.split("\n")[0];
    expect(userLine).toMatch(/^User: What is the status/);
  });

  it("preserves assistant messages that begin with [[reply_to_current]] verbatim", async () => {
    // Assistant messages may legitimately begin with [[reply_to_current]] or
    // [[reply_to:...]] (e.g. structured reply formatting or quoting the directive
    // protocol in a response). Stripping them would corrupt the searchable index.
    const assistantContent = "[[reply_to_current]] Here is the information you requested.";
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: assistantContent },
      }),
    ];
    const filePath = path.join(tmpDir, "assistant-reply-to-current.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The leading directive tag must NOT be stripped from assistant content
    expect(entry!.content).toContain("[[reply_to_current]]");
    expect(entry!.content).toContain("Here is the information you requested.");
    const assistantLine = entry!.content.split("\n")[0];
    expect(assistantLine).toMatch(/^Assistant: \[\[reply_to_current\]\]/);
  });

  it("preserves assistant messages that begin with [[reply_to:...]] verbatim", async () => {
    // Same gating check for the reply_to:<id> variant.
    const assistantContent = "[[reply_to:msg-456]] I am responding to that specific message.";
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: assistantContent },
      }),
    ];
    const filePath = path.join(tmpDir, "assistant-reply-to-id.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The leading directive tag must NOT be stripped from assistant content
    expect(entry!.content).toContain("[[reply_to:msg-456]]");
    expect(entry!.content).toContain("I am responding to that specific message.");
    const assistantLine = entry!.content.split("\n")[0];
    expect(assistantLine).toMatch(/^Assistant: \[\[reply_to:msg-456\]\]/);
  });

  it("preserves assistant messages that begin with a timestamp-like prefix verbatim", async () => {
    // Assistant responses may legitimately start with timestamp-formatted content,
    // e.g. quoting log lines, schedule entries, or cron expressions. The timestamp
    // envelope stripping must be gated to user messages only; assistant content
    // must be indexed verbatim.
    const assistantContent =
      "[Wed 2026-03-27 14:47 EDT] The deployment started at this time and completed successfully.";
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: assistantContent },
      }),
    ];
    const filePath = path.join(tmpDir, "assistant-timestamp-prefix.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The timestamp-like prefix must NOT be stripped from assistant content
    expect(entry!.content).toContain("[Wed 2026-03-27 14:47 EDT]");
    expect(entry!.content).toContain("The deployment started at this time");
    const assistantLine = entry!.content.split("\n")[0];
    expect(assistantLine).toMatch(/^Assistant: \[Wed 2026-03-27 14:47 EDT\]/);
  });

  it("strips both DOW timestamp and leading directive tag when both are present", async () => {
    // Channel messages can carry "[DOW YYYY-MM-DD HH:MM TZ] [[reply_to_current]] text".
    // The timestamp must be removed first so the directive-tag regex sees [[…]] at
    // position 0 of the remaining string.
    const userContent = "[Wed 2026-03-27 14:47 EDT] [[reply_to_current]] Please clarify that.";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "dow-timestamp-and-directive.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // Both the timestamp envelope and the leading directive tag must be stripped
    expect(entry!.content).not.toContain("[Wed 2026-03-27 14:47 EDT]");
    expect(entry!.content).not.toContain("[[reply_to_current]]");
    // The actual message body should be preserved
    expect(entry!.content).toContain("Please clarify that.");
    const userLine = entry!.content.split("\n")[0];
    expect(userLine).toMatch(/^User: Please clarify that\./);
  });
});
