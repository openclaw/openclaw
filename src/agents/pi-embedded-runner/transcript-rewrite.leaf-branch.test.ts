import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  makeAgentAssistantMessage,
  makeAgentToolResultMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { repro69486LineageFromProduction } from "./fixtures/repro-69486-lineage-from-production.js";
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

    const truncatedToolResult = makeAgentToolResultMessage({
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "[truncated] big tool output was elided" }],
      timestamp: 0,
    }) as AgentMessage;

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
            message: makeAgentToolResultMessage({
              toolCallId: "call_A",
              toolName: "read",
              content: [{ type: "text", text: "[truncated A]" }],
              timestamp: 0,
            }) as AgentMessage,
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
            message: makeAgentToolResultMessage({
              toolCallId: "call_A",
              toolName: "read",
              content: [{ type: "text", text: "[truncated AA]" }],
              timestamp: 0,
            }) as AgentMessage,
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

  // Repo-semantic regression guard: the session DAG is allowed to carry
  // unsummarized sibling branches from legitimate sm.branch() navigation.
  // Rewrite-triggered cleanup must only remove entries that the rewrite
  // itself just abandoned, not entries on parallel branches the user set up.
  // See src/agents/pi-embedded-runner/session-truncation.test.ts
  // "preserves unsummarized sibling branches during truncation".
  test("preserves legitimate sibling branches created before the rewrite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rewrite-sibling-test-"));
    try {
      const sm = SessionManager.create(dir, dir);
      sm.appendMessage(
        makeAgentUserMessage({ content: [{ type: "text", text: "hello" }], timestamp: 1 }),
      );
      sm.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "hi there" }], timestamp: 2 }),
      );
      const branchPoint = sm.getBranch();
      const branchFromId = branchPoint[branchPoint.length - 1].id;
      // Main branch: user turn then a tool result we will later truncate
      sm.appendMessage(
        makeAgentUserMessage({
          content: [{ type: "text", text: "do task with tool" }],
          timestamp: 3,
        }),
      );
      const mainToolResultId = sm.appendMessage(
        makeAgentToolResultMessage({
          toolCallId: "call_X",
          toolName: "read",
          content: [{ type: "text", text: "Y".repeat(200000) }],
          timestamp: 4,
        }),
      );
      sm.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "main tail" }], timestamp: 5 }),
      );
      // Sibling branch: go back to the branch-point and explore an alternate path
      sm.branch(branchFromId);
      const siblingUserId = sm.appendMessage(
        makeAgentUserMessage({
          content: [{ type: "text", text: "alternative question" }],
          timestamp: 6,
        }),
      );
      const siblingAssistantId = sm.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "alternative answer" }],
          timestamp: 7,
        }),
      );
      // Return to main branch so the rewrite operates there
      sm.branch(mainToolResultId);
      sm.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "post-sibling main continuation" }],
          timestamp: 8,
        }),
      );

      const sessionFile = sm.getSessionFile() as string;

      // Rewrite the main-branch tool result
      const result = await rewriteTranscriptEntriesInSessionFile({
        sessionFile,
        request: {
          replacements: [
            {
              entryId: mainToolResultId,
              message: makeAgentToolResultMessage({
                toolCallId: "call_X",
                toolName: "read",
                content: [{ type: "text", text: "[truncated main Y output]" }],
                timestamp: 4,
              }) as AgentMessage,
            },
          ],
        },
      });
      expect(result.changed).toBe(true);

      const smAfter = SessionManager.open(sessionFile);
      const allEntries = smAfter.getEntries();

      // The sibling branch entries must still be reachable in the full entry list.
      const siblingUser = allEntries.find((e) => e.id === siblingUserId);
      const siblingAssistant = allEntries.find((e) => e.id === siblingAssistantId);
      expect(siblingUser, "legitimate sibling user turn must be preserved").toBeDefined();
      expect(siblingAssistant, "legitimate sibling assistant turn must be preserved").toBeDefined();

      // And the sibling content must still be in the raw file.
      const raw = fs.readFileSync(sessionFile, "utf-8");
      expect(raw).toContain("alternative question");
      expect(raw).toContain("alternative answer");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Second repo-semantic regression guard: the sibling branch can hang off
  // an entry that lies INSIDE the rewritten suffix. The previous entry on
  // the main branch is strictly part of the shared history and must not be
  // garbage-collected just because this rewrite made a new copy of it —
  // the sibling's parentId still references the original, so removing it
  // would turn the sibling into an orphan root and destroy the shared-
  // ancestor relationship in the tree.
  test("preserves ancestry when a sibling branch hangs off the rewritten suffix", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rewrite-sibling-suffix-"));
    try {
      const sm = SessionManager.create(dir, dir);
      // Main branch head: user, assistant
      sm.appendMessage(
        makeAgentUserMessage({ content: [{ type: "text", text: "hello" }], timestamp: 1 }),
      );
      sm.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "hi there" }], timestamp: 2 }),
      );
      // Main branch continuation that WILL be the rewritten suffix:
      // userMid → toolResult (to be rewritten) → mainTailAssistant
      const userMidId = sm.appendMessage(
        makeAgentUserMessage({
          content: [{ type: "text", text: "please do the tool call" }],
          timestamp: 3,
        }),
      );
      const toolResultId = sm.appendMessage(
        makeAgentToolResultMessage({
          toolCallId: "call_Z",
          toolName: "read",
          content: [{ type: "text", text: "Z".repeat(200000) }],
          timestamp: 4,
        }),
      );
      const mainTailId = sm.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "main tail after tool" }],
          timestamp: 5,
        }),
      );
      // Sibling branch forks from toolResultId — an entry that WILL be
      // rewritten. The sibling references that id as its parent. The
      // rewrite must not strand the sibling by dropping its parent.
      sm.branch(toolResultId);
      const siblingUserId = sm.appendMessage(
        makeAgentUserMessage({
          content: [{ type: "text", text: "sibling alt question" }],
          timestamp: 6,
        }),
      );
      const siblingAssistantId = sm.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "sibling alt answer" }],
          timestamp: 7,
        }),
      );
      // Return to main tail so the rewrite operates there.
      sm.branch(mainTailId);
      sm.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "main continuation take 2" }],
          timestamp: 8,
        }),
      );

      const sessionFile = sm.getSessionFile() as string;

      // Rewrite the tool result — which is in the suffix, BUT userMidId is its
      // parent and is also the shared ancestor of the sibling branch. Whatever
      // the cleanup does, it MUST NOT orphan the sibling.
      const result = await rewriteTranscriptEntriesInSessionFile({
        sessionFile,
        request: {
          replacements: [
            {
              entryId: toolResultId,
              message: makeAgentToolResultMessage({
                toolCallId: "call_Z",
                toolName: "read",
                content: [{ type: "text", text: "[truncated suffix Z]" }],
                timestamp: 4,
              }) as AgentMessage,
            },
          ],
        },
      });
      expect(result.changed).toBe(true);

      const smAfter = SessionManager.open(sessionFile);
      const allEntries = smAfter.getEntries();
      const byId = new Map(allEntries.map((e) => [e.id, e]));

      // Sibling user + assistant must still exist.
      const siblingUser = byId.get(siblingUserId);
      const siblingAssistant = byId.get(siblingAssistantId);
      expect(siblingUser, "sibling user turn must be preserved").toBeDefined();
      expect(siblingAssistant, "sibling assistant turn must be preserved").toBeDefined();

      // Crucial: the sibling branch must still have ancestry. Walk sibling's
      // parentId chain back up; every referenced parent must still exist in
      // the file. Otherwise the sibling is orphaned and the tree is corrupt.
      const visited = new Set<string>();
      let cursor: typeof siblingAssistant = siblingAssistant;
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        const parentId = (cursor as { parentId?: string | null }).parentId;
        if (!parentId) {
          break;
        }
        const parent = byId.get(parentId);
        expect(
          parent,
          `sibling ancestry broken: parentId ${parentId} of ${cursor.id} no longer present`,
        ).toBeDefined();
        cursor = parent;
      }

      // And the shared-ancestor userMidId message must specifically still be
      // in the file — it is the fork-point and both branches need it.
      const userMid = byId.get(userMidId);
      expect(userMid, "shared-ancestor user turn must be preserved").toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production-derived fixture preserves shared ancestor while cleaning the rewrite-abandoned child (#69486)", async () => {
    writeSession(sessionFile, repro69486LineageFromProduction);

    const preIds = new Set(readEntries(sessionFile).map((e) => e.id as string));
    expect(preIds.has("msg-assistant-parent")).toBe(true);
    expect(preIds.has("msg-toolresult-1a")).toBe(true);
    expect(preIds.has("msg-toolresult-1b")).toBe(true);

    const result = await rewriteTranscriptEntriesInSessionFile({
      sessionFile,
      request: {
        replacements: [
          {
            entryId: "msg-assistant-parent",
            message: makeAgentAssistantMessage({
              content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
              timestamp: 0,
            }) as AgentMessage,
          },
        ],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.rewrittenEntries).toBe(1);

    const after = readEntries(sessionFile);
    const afterIds = new Set(after.map((e) => e.id as string));

    expect(afterIds.has("msg-assistant-parent")).toBe(true);
    expect(afterIds.has("msg-toolresult-1a")).toBe(true);
    expect(afterIds.has("msg-toolresult-1b")).toBe(false);

    const toolResultsForParent = after.filter(
      (e) =>
        (e as { parentId?: string }).parentId === "msg-assistant-parent" &&
        (e as { type?: string }).type === "message" &&
        ((e as { message?: { role?: string } }).message?.role ?? "") === "toolResult",
    );
    expect(toolResultsForParent.length).toBeLessThanOrEqual(1);

    for (const e of after) {
      const pid = (e as { parentId?: string | null }).parentId;
      if (pid && pid !== null) {
        expect(afterIds.has(pid)).toBe(true);
      }
    }
  });
});
