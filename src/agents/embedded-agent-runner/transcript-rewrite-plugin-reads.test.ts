// Plugin transcript reads after branch rewrites: supersedes markers and reset-window cursors.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  readSessionTranscriptVisibleMessageDelta,
  readVisibleSessionTranscriptMessageEntries,
} from "../../plugin-sdk/session-transcript-runtime.js";
import { useTranscriptRewriteTempDirs } from "./transcript-rewrite.test-support.js";

let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
const tempDirs = useTranscriptRewriteTempDirs(afterEach);

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function appendSessionMessages(
  sessionManager: SessionManager,
  messages: AppendMessage[],
): string[] {
  return messages.map((message) => sessionManager.appendMessage(message));
}

async function createPersistedRewriteTarget(sessionId: string) {
  const directory = tempDirs.make(`openclaw-${sessionId}-`);
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(directory, "sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
  return { directory, target };
}

function createTextContent(text: string) {
  return [{ type: "text", text }];
}

function createToolResultReplacement(toolName: string, text: string, timestamp: number) {
  return asAppendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName,
    content: createTextContent(text),
    isError: false,
    timestamp,
  });
}

beforeAll(async () => {
  ({ rewriteTranscriptEntriesInSessionManager } = await import("./transcript-rewrite.js"));
});

describe("plugin transcript reads after rewrites", () => {
  it("marks re-appended messages with the entry id they supersede", async () => {
    const { directory, target } = await createPersistedRewriteTarget("supersedes-rewrite");
    const readMarkers = async () => {
      await waitForSessionTranscriptProjection(target);
      const visible = await readVisibleSessionTranscriptMessageEntries(target);
      const delta = await readSessionTranscriptVisibleMessageDelta(target);
      if (delta.kind !== "page") {
        throw new Error(`expected visible delta page, got ${delta.kind}`);
      }
      const markers = (entries: typeof visible) =>
        entries.map((entry) => [entry.entryId, entry.supersedesEntryId]);
      // Both plugin read paths project the same marker; seq differs by read contract.
      expect(markers(delta.entries)).toEqual(markers(visible));
      return markers(visible);
    };
    const manager = SessionManager.open(target, directory);
    const [userId, callId, toolId, tailId] = appendSessionMessages(manager, [
      asAppendMessage({ role: "user", content: "read file", timestamp: 1 }),
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
      asAppendMessage(createToolResultReplacement("read", "large original result", 3)),
      asAppendMessage({ role: "assistant", content: createTextContent("summary"), timestamp: 4 }),
    ]);
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        {
          entryId: expectDefined(toolId, "tool result entry id"),
          message: createToolResultReplacement("read", "short", 3),
        },
      ],
    });
    const [toolCopyId, tailCopyId] = manager
      .getBranch()
      .slice(2)
      .map((entry) => entry.id);
    const plainId = manager.appendMessage(
      asAppendMessage({ role: "user", content: "after rewrite", timestamp: 5 }),
    );
    expect(await readMarkers()).toEqual([
      [userId, undefined],
      [callId, undefined],
      [toolCopyId, toolId],
      [tailCopyId, tailId],
      [plainId, undefined],
    ]);

    // A reloaded copy must match its committed row so a later rewrite can chain from it.
    const reopened = SessionManager.open(target, directory);
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager: reopened,
      replacements: [
        {
          entryId: expectDefined(toolCopyId, "tool result copy id"),
          message: createToolResultReplacement("read", "shorter", 3),
        },
      ],
    });
    const [toolSecondCopyId, tailSecondCopyId, plainCopyId] = reopened
      .getBranch()
      .slice(2)
      .map((entry) => entry.id);
    expect(await readMarkers()).toEqual([
      [userId, undefined],
      [callId, undefined],
      [toolSecondCopyId, toolCopyId],
      [tailSecondCopyId, tailCopyId],
      [plainCopyId, plainId],
    ]);
    expect(SessionManager.open(target, directory).getBranch()).toEqual(reopened.getBranch());
  });

  it("reports a reset after a rewrite as session_reset to reset-window cursors", async () => {
    const { directory, target } = await createPersistedRewriteTarget("rewrite-then-reset");
    const manager = SessionManager.open(target, directory);
    const toolId = appendSessionMessages(manager, [
      asAppendMessage({ role: "user", content: "read file", timestamp: 1 }),
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
      asAppendMessage(createToolResultReplacement("read", "large original result", 3)),
      asAppendMessage({ role: "assistant", content: createTextContent("summary"), timestamp: 4 }),
    ])[2];
    await waitForSessionTranscriptProjection(target);
    const drained = await readSessionTranscriptVisibleMessageDelta({
      ...target,
      start: "reset-window",
    });
    if (drained.kind !== "page") {
      throw new Error(`expected visible delta page, got ${drained.kind}`);
    }
    // The rewrite re-appends the cursor's anchor; the reset then closes its window.
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        {
          entryId: expectDefined(toolId, "tool result entry id"),
          message: createToolResultReplacement("read", "short", 3),
        },
      ],
    });
    await resetSessionEntryLifecycle({
      agentId: target.agentId,
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      resetBoundary: { context: "clear", reason: "reset", cwd: directory },
      buildNextEntry: ({ currentEntry }) => ({
        ...expectDefined(currentEntry, "current session entry"),
        updatedAt: 2,
      }),
    });
    await waitForSessionTranscriptProjection(target);

    const reset = await readSessionTranscriptVisibleMessageDelta({
      ...target,
      cursor: drained.cursor,
    });
    expect(reset).toMatchObject({ kind: "reset", reason: "session_reset" });
    if (reset.kind !== "reset") {
      throw new Error("expected a session reset");
    }
    await expect(
      readSessionTranscriptVisibleMessageDelta({ ...target, cursor: reset.cursor }),
    ).resolves.toMatchObject({ kind: "page", entries: [], hasMore: false });
  });
});
