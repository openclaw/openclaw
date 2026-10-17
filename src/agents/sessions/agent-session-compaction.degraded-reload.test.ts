import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  safeguardFixture,
  sessionTarget,
  textStream,
} from "./agent-session-boundary.test-support.js";
import {
  collectCompactionEnds,
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
registerAgentSessionLoopTestLifecycle();

const LATEST_ASK = "preserve the pending deployment status";
const OVERSIZED_IDENTIFIER = `https://example.com/${"a".repeat(16_000)}`;
const PRIOR_SUMMARY = [
  "## Decisions\nDeploy through the blue stack only.",
  "## Open TODOs\nNone.",
  "## Constraints/Rules\nNever restart the database during business hours.",
  "## Pending user asks\nNone.",
  "## Exact identifiers\nNone.",
].join("\n");
const model: Model = { ...testModel, api: "compaction-test-api", contextWindow: 200_000 };

async function reopen(target: { storePath: string }, dir: string): Promise<SessionManager> {
  const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
  expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
  return SessionManager.open(target as Parameters<typeof SessionManager.open>[0], dir);
}

function lastCompaction(sessionManager: SessionManager) {
  return expectDefined(
    sessionManager.getBranch().findLast((candidate) => candidate.type === "compaction"),
    "expected a persisted compaction boundary",
  );
}

it.each([
  { name: "fresh session", priorBoundary: false },
  { name: "existing session", priorBoundary: true },
])("reopens and continues from a degraded boundary in a $name", async ({ priorBoundary }) => {
  const dir = tempDirs.make("openclaw-degraded-compaction-reload-");
  const target = sessionTarget(
    path.join(dir, "sessions.json"),
    `degraded-reload-${priorBoundary ? "existing" : "fresh"}`,
  );
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  let sessionManager = SessionManager.open(target, dir);
  if (priorBoundary) {
    // The boundary shape written before this change: no qualityDegraded field.
    sessionManager.appendMessage({ role: "user", content: "earliest prompt", timestamp: 1 });
    const keptId = sessionManager.appendMessage({
      ...createAssistant(model, "earliest answer"),
      timestamp: 2,
    });
    sessionManager.appendCompaction(
      PRIOR_SUMMARY,
      keptId,
      1_000,
      { readFiles: [], modifiedFiles: [] },
      true,
    );
    sessionManager.flushPendingPersistence();
    sessionManager = await reopen(target, dir);
  }
  sessionManager.appendMessage({
    role: "user",
    content: `${LATEST_ASK} ${OVERSIZED_IDENTIFIER}`,
    timestamp: 3,
  });
  sessionManager.appendMessage({ ...createAssistant(model, "old answer"), timestamp: 4 });
  sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 5 });
  streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
    textStream(activeModel, "Summary without headings"),
  );
  const fixture = await safeguardFixture(model, sessionManager);
  const { session, settingsManager, network } = fixture;
  try {
    const beforeCompaction = expectDefined(loadSessionEntry(target), "session fixture exists");
    expect(beforeCompaction.compactionQualityDegraded).toBeUndefined();
    const compactionEvents = collectCompactionEnds(session);
    await session.compact();
    expect(compactionEvents).toMatchObject([
      { outcome: { status: "completed", qualityDegraded: true } },
    ]);
    expect(loadSessionEntry(target)?.compactionQualityDegraded).toBe(true);
    // A stale accounting snapshot cannot clear a loss already committed by the transcript owner.
    await replaceSessionEntry(target, { ...beforeCompaction, updatedAt: 2 });
    expect(loadSessionEntry(target)?.compactionQualityDegraded).toBe(true);
    session.dispose();
    sessionManager.flushPendingPersistence();

    const reopened = await reopen(target, dir);
    expect(loadSessionEntry(target)?.compactionQualityDegraded).toBe(true);
    const boundary = lastCompaction(reopened);
    expect(boundary.details).toMatchObject({ qualityDegraded: true });
    expect(boundary.summary).toContain("## Pending user asks\nLatest user request context:");
    expect(boundary.summary).toContain(LATEST_ASK);
    expect(boundary.summary).not.toContain(OVERSIZED_IDENTIFIER);
    expect(boundary.summary).toContain("Summary without headings");
    const replay = JSON.stringify(reopened.buildSessionContext().messages);
    expect(replay).toContain(LATEST_ASK);
    expect(replay).not.toContain(OVERSIZED_IDENTIFIER);

    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return textStream(activeModel, "continued answer");
    });
    const continued = await createTestSession({
      model,
      sessionManager: reopened,
      settingsManager,
    });
    await continued.session.prompt("next question");
    continued.session.dispose();
    expect(requests).toHaveLength(1);
    const request = JSON.stringify(requests[0]?.messages);
    expect(request).toContain("Latest user request context:");
    expect(request).toContain(LATEST_ASK);
    expect(request).toContain("next question");
    expect(request).not.toContain(OVERSIZED_IDENTIFIER);
    reopened.flushPendingPersistence();
    const afterTurn = await reopen(target, dir);
    expect(lastCompaction(afterTurn).id).toBe(boundary.id);
    expect(afterTurn.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "continued answer" }],
    });
    expect(network).not.toHaveBeenCalled();
    await replaceSessionEntry(target, {
      ...beforeCompaction,
      lifecycleRevision: "fresh-lifecycle",
      updatedAt: 3,
    });
    expect(loadSessionEntry(target)?.compactionQualityDegraded).toBeUndefined();
  } finally {
    fixture.dispose();
  }
});
