/**
 * A degraded safeguard boundary is durable session state. These cases write it through the
 * real SQLite transcript, reopen the session from disk, and send the next request, for a
 * fresh session and for one that already carried a boundary from before `qualityDegraded`
 * existed. The trigger is the oversized-identifier case: the retention plan cannot fit the
 * identifier, and the request context must still reach the saved and replayed summary.
 */
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

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
  "## Decisions",
  "Deploy through the blue stack only.",
  "## Open TODOs",
  "None.",
  "## Constraints/Rules",
  "Never restart the database during business hours.",
  "## Pending user asks",
  "None.",
  "## Exact identifiers",
  "None.",
].join("\n");
// A synthetic API plus the registered stream keep the real summarizer offline.
const model: Model = { ...testModel, api: "compaction-test-api", contextWindow: 200_000 };

function reopen(target: { storePath: string }, dir: string): SessionManager {
  const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
  expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
  return SessionManager.open(target as Parameters<typeof SessionManager.open>[0], dir);
}

function lastCompaction(sessionManager: SessionManager) {
  const entry = sessionManager.getBranch().findLast((candidate) => candidate.type === "compaction");
  if (entry?.type !== "compaction") {
    throw new Error("expected a persisted compaction boundary");
  }
  return entry;
}

describe("AgentSession degraded compaction reload", () => {
  it.each([
    { name: "fresh session", priorBoundary: false },
    { name: "existing session", priorBoundary: true },
  ])("reopens and continues from a degraded boundary in a $name", async ({ priorBoundary }) => {
    const dir = tempDirs.make("openclaw-degraded-compaction-reload-");
    const target = {
      agentId: "main",
      sessionId: `degraded-reload-${priorBoundary ? "existing" : "fresh"}`,
      sessionKey: `agent:main:degraded-reload-${priorBoundary ? "existing" : "fresh"}`,
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    let sessionManager = SessionManager.open(target, dir);
    if (priorBoundary) {
      // The boundary shape written before this change: no qualityDegraded field.
      sessionManager.appendMessage({ role: "user", content: "earliest prompt", timestamp: 1 });
      const keptId = sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: "earliest answer" }]),
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
      sessionManager = reopen(target, dir);
    }
    sessionManager.appendMessage({
      role: "user",
      content: `${LATEST_ASK} ${OVERSIZED_IDENTIFIER}`,
      timestamp: 3,
    });
    sessionManager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: "old answer" }]),
      timestamp: 4,
    });
    sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 5 });
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request in compaction test"));
    const eventBus = createEventBus();
    try {
      const resourceLoader = createResourceLoader();
      const extensions = resourceLoader.getExtensions();
      extensions.extensions.push(
        await loadExtensionFromFactory(
          compactionSafeguardExtension,
          sessionManager.getCwd(),
          eventBus,
          extensions.runtime,
        ),
      );
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "Summary without headings" }]),
        ),
      );
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
        retry: { enabled: false },
      });
      const { session } = await createTestSession({
        model,
        sessionManager,
        resourceLoader,
        settingsManager,
      });
      await session.compact();
      session.dispose();
      sessionManager.flushPendingPersistence();

      // Reload: the boundary, its durable flag, and the request context come back from disk.
      const reopened = reopen(target, dir);
      const boundary = lastCompaction(reopened);
      expect(boundary.details).toMatchObject({ qualityDegraded: true });
      expect(boundary.summary).toContain("## Pending user asks\nLatest user request context:");
      expect(boundary.summary).toContain(LATEST_ASK);
      expect(boundary.summary).not.toContain(OVERSIZED_IDENTIFIER);
      if (priorBoundary) {
        expect(boundary.summary).toContain("Never restart the database during business hours.");
      }
      const replay = JSON.stringify(reopened.buildSessionContext().messages);
      expect(replay).toContain(LATEST_ASK);
      expect(replay).not.toContain(OVERSIZED_IDENTIFIER);

      // Continuation: the next request is built from the reopened degraded boundary.
      const requests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        requests.push(context);
        return createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "continued answer" }]),
        );
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
      const afterTurn = reopen(target, dir);
      expect(lastCompaction(afterTurn).id).toBe(boundary.id);
      expect(afterTurn.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "continued answer" }],
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      setCompactionSafeguardRuntime(sessionManager, null);
      eventBus.clear();
      network.mockRestore();
    }
  });
});
