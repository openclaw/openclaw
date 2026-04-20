import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rewriteTranscriptEntriesInSessionFile } from "./transcript-rewrite.js";

type RawEntry = Record<string, unknown>;

function tmpSessionDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSession(sessionFile: string, entries: RawEntry[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(sessionFile, content, "utf-8");
}

function readEntries(sessionFile: string): RawEntry[] {
  return fs
    .readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawEntry);
}

function buildMessage(role: "user" | "assistant" | "toolResult", text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

describe("rewriteTranscriptEntriesInSessionFile — leaf-branch compaction", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(() => {
    dir = tmpSessionDir("openclaw-transcript-rewrite-test-");
    sessionFile = path.join(dir, "test-session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("removes abandoned siblings left over by rewrite so the raw file carries each turn only once", async () => {
    // Build a session file with: session header, user, assistant with
    // a toolResult to be truncated, assistant reply, then another
    // downstream message that the rewrite will push past.
    const base: RawEntry[] = [
      {
        type: "session",
        version: 3,
        id: "session-root",
        timestamp: "2026-04-20T15:43:01.559Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "msg-user-1",
        parentId: "session-root",
        timestamp: "2026-04-20T15:43:10.000Z",
        message: { role: "user", content: [{ type: "text", text: "do a tool call" }] },
      },
      {
        type: "message",
        id: "msg-assistant-1",
        parentId: "msg-user-1",
        timestamp: "2026-04-20T15:43:11.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "read",
              arguments: { path: "/tmp/big-file.txt" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "msg-toolresult-1",
        parentId: "msg-assistant-1",
        timestamp: "2026-04-20T15:43:12.000Z",
        message: {
          role: "toolResult",
          content: [
            {
              type: "toolResult",
              toolCallId: "call_1",
              output: "X".repeat(200000),
            },
          ],
        },
      },
      {
        type: "message",
        id: "msg-assistant-2",
        parentId: "msg-toolresult-1",
        timestamp: "2026-04-20T15:43:13.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "here is what i found" }],
        },
      },
      {
        type: "message",
        id: "msg-user-2",
        parentId: "msg-assistant-2",
        timestamp: "2026-04-20T15:43:14.000Z",
        message: { role: "user", content: [{ type: "text", text: "thanks" }] },
      },
    ];
    writeSession(sessionFile, base);

    const truncatedToolResult = buildMessage(
      "toolResult",
      "[truncated] big tool output was elided",
    );

    const result = await rewriteTranscriptEntriesInSessionFile({
      sessionFile,
      request: {
        replacements: [{ entryId: "msg-toolresult-1", message: truncatedToolResult }],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.rewrittenEntries).toBe(1);

    const after = readEntries(sessionFile);
    // Must still have exactly one session header.
    const sessionHeaders = after.filter((e) => e.type === "session");
    expect(sessionHeaders).toHaveLength(1);

    // Extract all "message" entries and check their ids are unique (no abandoned duplicates).
    const messageIds = after.filter((e) => e.type === "message").map((e) => e.id as string);
    expect(new Set(messageIds).size).toBe(messageIds.length);

    // The concrete text content of downstream messages must appear at most once in
    // the raw file — that is the regression we're guarding.
    const assistantTextCount = after.filter((e) => {
      if (e.type !== "message") {
        return false;
      }
      const msg = e.message as { role?: string; content?: unknown };
      if (msg.role !== "assistant") {
        return false;
      }
      const content = msg.content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          (block as { text?: unknown }).text === "here is what i found",
      );
    }).length;
    expect(assistantTextCount).toBe(1);

    const userText2Count = after.filter((e) => {
      if (e.type !== "message") {
        return false;
      }
      const msg = e.message as { role?: string; content?: unknown };
      if (msg.role !== "user") {
        return false;
      }
      const content = msg.content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          (block as { text?: unknown }).text === "thanks",
      );
    }).length;
    expect(userText2Count).toBe(1);

    // The pre-replacement tool result content must no longer exist on disk —
    // only the truncated replacement should remain on the active leaf chain.
    const rawFile = fs.readFileSync(sessionFile, "utf-8");
    expect(rawFile).not.toContain("X".repeat(200000));
    expect(rawFile).toContain("[truncated] big tool output was elided");
  });

  test("repeated rewrites do not pile up cumulative duplicates of the same turn", async () => {
    // Two sequential rewrites simulate the observed live loop: after each
    // rewrite, the previous rewrite's leaf branch must not remain as a
    // second abandoned sibling.
    const base: RawEntry[] = [
      {
        type: "session",
        version: 3,
        id: "session-root",
        timestamp: "2026-04-20T15:43:01.559Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "msg-user-1",
        parentId: "session-root",
        timestamp: "2026-04-20T15:43:10.000Z",
        message: { role: "user", content: [{ type: "text", text: "run tool A" }] },
      },
      {
        type: "message",
        id: "msg-assistant-1",
        parentId: "msg-user-1",
        timestamp: "2026-04-20T15:43:11.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_A", name: "read", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "msg-toolresult-A",
        parentId: "msg-assistant-1",
        timestamp: "2026-04-20T15:43:12.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "toolResult", toolCallId: "call_A", output: "A".repeat(200000) }],
        },
      },
      {
        type: "message",
        id: "msg-assistant-2",
        parentId: "msg-toolresult-A",
        timestamp: "2026-04-20T15:43:13.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done with A" }] },
      },
    ];
    writeSession(sessionFile, base);

    // First rewrite: truncate tool result A.
    await rewriteTranscriptEntriesInSessionFile({
      sessionFile,
      request: {
        replacements: [
          {
            entryId: "msg-toolresult-A",
            message: buildMessage("toolResult", "[truncated A]"),
          },
        ],
      },
    });

    // Find the new toolresult id on the live leaf (last message row).
    const entriesAfterFirst = readEntries(sessionFile);
    const rewrittenToolResult = entriesAfterFirst.toReversed().find((e) => {
      if (e.type !== "message") {
        return false;
      }
      const msg = e.message as { role?: string };
      return msg.role === "toolResult";
    });
    expect(rewrittenToolResult).toBeDefined();

    // Second rewrite: truncate the already-truncated toolResult entry once more.
    // The second rewrite must not leave a second abandoned branch.
    await rewriteTranscriptEntriesInSessionFile({
      sessionFile,
      request: {
        replacements: [
          {
            entryId: rewrittenToolResult!.id as string,
            message: buildMessage("toolResult", "[truncated AA]"),
          },
        ],
      },
    });

    const final = readEntries(sessionFile);
    // Only one session header.
    expect(final.filter((e) => e.type === "session")).toHaveLength(1);

    // No duplicate message IDs.
    const ids = final.filter((e) => e.type === "message").map((e) => e.id as string);
    expect(new Set(ids).size).toBe(ids.length);

    // The original "done with A" assistant text must appear exactly once on the
    // final leaf (it was re-appended with a new ID by each rewrite; only the
    // newest copy should survive).
    const doneACount = final.filter((e) => {
      if (e.type !== "message") {
        return false;
      }
      const msg = e.message as { role?: string; content?: unknown };
      if (msg.role !== "assistant") {
        return false;
      }
      const content = msg.content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          (block as { text?: unknown }).text === "done with A",
      );
    }).length;
    expect(doneACount).toBe(1);
  });
});
