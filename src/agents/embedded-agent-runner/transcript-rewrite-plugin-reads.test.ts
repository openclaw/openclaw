import assert from "node:assert/strict";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  readSessionTranscriptVisibleMessageDelta as readDelta,
  readVisibleSessionTranscriptMessageEntries as readVisibleEntries,
} from "../../plugin-sdk/session-transcript-runtime.js";
import { castAgentMessage, castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import { useTranscriptRewriteTempDirs } from "./transcript-rewrite.test-support.js";

let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
const tempDirs = useTranscriptRewriteTempDirs(afterEach);

async function createTranscript(sessionId: string) {
  const directory = tempDirs.make(`openclaw-${sessionId}-`);
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(directory, "sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
  const manager = SessionManager.open(target, directory);
  const ids = castAgentMessages([
    { role: "user", content: "read file", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: 2,
    },
    createToolResultReplacement("large original result"),
    {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      timestamp: 4,
    },
  ]).map((message) => manager.appendMessage(message));
  return { directory, target, manager, ids };
}

function createToolResultReplacement(text: string) {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  });
}

function rewrite(manager: SessionManager, entryId: string | undefined, text: string) {
  const replacement = {
    entryId: expectDefined(entryId, "tool result entry id"),
    message: createToolResultReplacement(text),
  };
  return rewriteTranscriptEntriesInSessionManager({
    sessionManager: manager,
    replacements: [replacement],
  });
}

function rewrittenIds(manager: SessionManager) {
  const branch = manager.getBranch();
  return branch.slice(2).map((entry) => entry.id);
}

beforeAll(async () => {
  ({ rewriteTranscriptEntriesInSessionManager } = await import("./transcript-rewrite.js"));
});

it("marks re-appended messages with the entry id they supersede", async () => {
  const { directory, target, manager, ids } = await createTranscript("supersedes-rewrite");
  const [userId, callId, toolId, tailId] = ids;
  const readMarkers = async () => {
    await waitForSessionTranscriptProjection(target);
    const visible = await readVisibleEntries(target);
    const delta = await readDelta(target);
    assert(delta.kind === "page", `expected visible delta page, got ${delta.kind}`);
    const markers = (entries: typeof visible) =>
      entries.map((entry) => [entry.entryId, entry.supersedesEntryId]);
    // Both plugin read paths project the same marker; seq differs by read contract.
    expect(markers(delta.entries)).toEqual(markers(visible));
    return markers(visible);
  };
  await rewrite(manager, toolId, "short");
  const [toolCopyId, tailCopyId] = rewrittenIds(manager);
  const plainId = manager.appendMessage(
    castAgentMessage({ role: "user", content: "after rewrite", timestamp: 5 }),
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
  await rewrite(reopened, toolCopyId, "shorter");
  const [toolSecondCopyId, tailSecondCopyId, plainCopyId] = rewrittenIds(reopened);
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
  const { directory, target, manager, ids } = await createTranscript("rewrite-then-reset");
  await waitForSessionTranscriptProjection(target);
  const drained = await readDelta({ ...target, start: "reset-window" });
  assert(drained.kind === "page", `expected visible delta page, got ${drained.kind}`);
  await rewrite(manager, ids[2], "short");
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

  const reset = await readDelta({ ...target, cursor: drained.cursor });
  expect(reset).toMatchObject({ kind: "reset", reason: "session_reset" });
  assert(reset.kind === "reset", "expected a session reset");
  await expect(readDelta({ ...target, cursor: reset.cursor })).resolves.toMatchObject({
    kind: "page",
    entries: [],
    hasMore: false,
  });
});
