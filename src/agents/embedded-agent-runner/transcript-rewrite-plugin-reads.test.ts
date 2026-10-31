import { expectDefined } from "@openclaw/normalization-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeAll, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  readSessionTranscriptVisibleMessageDelta,
  readVisibleSessionTranscriptMessageEntries,
} from "../../plugin-sdk/session-transcript-runtime.js";
import {
  appendMessages as appendSessionMessages,
  asAppendMessage,
  useTranscriptRewriteTargets,
} from "./transcript-rewrite.test-support.js";

let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
const createPersistedRewriteTarget = useTranscriptRewriteTargets(afterEach);

function toolResult(text: string) {
  return asAppendMessage(makeTextToolResult("call_1", "read", text, false, 3));
}

function rewriteTool(sessionManager: SessionManager, entryId: string | undefined, text = "short") {
  return rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: [
      { entryId: expectDefined(entryId, "tool result entry id"), message: toolResult(text) },
    ],
  });
}

const rewriteHistory = [
  asAppendMessage({ role: "user", content: "read file", timestamp: 1 }),
  asAppendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    timestamp: 2,
  }),
  toolResult("large original result"),
  asAppendMessage({
    role: "assistant",
    content: [{ type: "text", text: "summary" }],
    timestamp: 4,
  }),
];

beforeAll(async () => {
  ({ rewriteTranscriptEntriesInSessionManager } = await import("./transcript-rewrite.js"));
});

it("preserves supersession across reloads, then resets an anchored reader", async () => {
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
    expect(markers(delta.entries)).toEqual(markers(visible));
    return markers(visible);
  };
  const manager = SessionManager.open(target, directory);
  const [userId, callId, toolId, tailId] = appendSessionMessages(manager, rewriteHistory);
  await rewriteTool(manager, toolId);
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

  const drained = await readSessionTranscriptVisibleMessageDelta({
    ...target,
    start: "reset-window",
  });
  if (drained.kind !== "page") {
    throw new Error(`expected visible delta page, got ${drained.kind}`);
  }

  const reopened = SessionManager.open(target, directory);
  await rewriteTool(reopened, toolCopyId, "shorter");
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
