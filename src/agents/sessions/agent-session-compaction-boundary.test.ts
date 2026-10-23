import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readTranscriptStorageRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
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

it("never replays conversation before a prior compaction whose retained entry precedes its marker", async () => {
  const dir = tempDirs.make("openclaw-compaction-boundary-");
  const scope = {
    agentId: "main",
    sessionId: "boundary-proof",
    sessionKey: "agent:main:boundary-proof",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, {
    sessionFile: formatSqliteSessionFileMarker(scope),
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const sessionManager = SessionManager.open(scope, dir);
  function appendToolRound(id: string, text: string, at: number, doneAt = at) {
    const entryId = sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "toolCall", id, name: "read", arguments: {} }]),
      timestamp: at,
    });
    sessionManager.appendMessage(makeTextToolResult(id, "read", text, false, doneAt));
    return entryId;
  }
  sessionManager.appendMessage(makeUserMessage("Tetris", 1));
  const retainedId = appendToolRound("retained-call", "retained tool result".repeat(100), 2, 3);
  appendToolRound("second-retained", "second retained tool result", 3);
  sessionManager.appendCompaction("Prior work is summarized.", retainedId, 100);
  appendToolRound("new-call", "new tool result", 4, 5);
  const summarize = vi.fn<CompactionProvider["summarize"]>(
    async () =>
      "## Decisions\nContinue.\n\n## Open TODOs\nNone.\n\n## Constraints/Rules\nNone.\n\n## Pending user asks\nNone.\n\n## Exact identifiers\nNone.",
  );
  const registration = {
    provider: { id: "boundary-proof", label: "Boundary proof", summarize },
  };
  const registry = requireActivePluginRegistry();
  registry.compactionProviders.push(registration);
  setCompactionSafeguardRuntime(sessionManager, {
    provider: registration.provider.id,
    model: testModel,
    recentTurnsPreserve: 0,
    qualityGuardEnabled: false,
  });
  try {
    const resourceLoader = await createResourceLoader(compactionSafeguardExtension, {
      cwd: sessionManager.getCwd(),
      agentDir: path.join(dir, "agent"),
    });
    const { session } = await createTestSession({
      sessionManager,
      resourceLoader,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 100 },
        retry: { enabled: false },
      }),
    });
    const database = openOpenClawAgentDatabase(scope);
    const before = readTranscriptStorageRows(database, scope.sessionId);
    const version = database.db.prepare("PRAGMA user_version").get();
    const retainedMessages = sessionManager
      .getBranch()
      .slice(1, 3)
      .map((entry) => (entry.type === "message" ? entry.message : undefined));
    await session.compact();
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0].messages).toEqual(retainedMessages);
    expect(readTranscriptStorageRows(database, scope.sessionId).slice(0, -1)).toEqual(before);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual(version);
  } finally {
    setCompactionSafeguardRuntime(sessionManager, null);
    registry.compactionProviders.splice(registry.compactionProviders.indexOf(registration), 1);
  }
});
