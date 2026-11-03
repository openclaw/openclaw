import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
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

describe("AgentSession compaction boundary", () => {
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
    sessionManager.appendMessage(makeUserMessage("Tetris", 1));
    const retainedId = sessionManager.appendMessage({
      ...createAssistant(testModel, [
        { type: "toolCall", id: "retained-call", name: "read", arguments: {} },
      ]),
      timestamp: 2,
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "retained-call",
      toolName: "read",
      content: [{ type: "text", text: "retained tool result".repeat(100) }],
      isError: false,
      timestamp: 3,
    });
    sessionManager.appendMessage({
      ...createAssistant(testModel, [
        { type: "toolCall", id: "second-retained", name: "read", arguments: {} },
      ]),
      timestamp: 3,
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "second-retained",
      toolName: "read",
      content: [{ type: "text", text: "second retained tool result" }],
      isError: false,
      timestamp: 3,
    });
    sessionManager.appendCompaction("Prior work is summarized.", retainedId, 100);
    sessionManager.appendMessage({
      ...createAssistant(testModel, [
        { type: "toolCall", id: "new-call", name: "read", arguments: {} },
      ]),
      timestamp: 4,
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "new-call",
      toolName: "read",
      content: [{ type: "text", text: "new tool result" }],
      isError: false,
      timestamp: 5,
    });
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
      eventBus.clear();
    }
  });
});

it.each(["human", "internal", "steering"] as const)(
  "preserves the %s request across two real semantic-window recoveries",
  async (kind) => {
    const dir = tempDirs.make("openclaw-request-recovery-");
    const scope = {
      agentId: "main",
      sessionId: "request-recovery",
      sessionKey: "agent:main:request-recovery",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const request = "Review the patch; do not deploy it.";
    const steering = "Also check the upgrade path.";
    let manager = await SessionManager.openAsync(scope, dir, {
      maxEvents: 1000,
      maxBytes: 1_000_000,
    });
    await manager.appendMessageAsync(makeUserMessage("Completed earlier human task", 1));
    await manager.appendMessageAsync(
      createAssistant(testModel, [{ type: "text", text: "Completed." }]),
    );
    const requestFromEntryId = await manager.appendMessageAsync({
      ...makeUserMessage(request, 3),
      ...(kind === "internal" ? { provenance: { kind: "inter_session" as const } } : {}),
    });
    for (let generation = 0; generation < 2; generation++) {
      if (generation > 0) {
        manager = await SessionManager.openAsync(scope, dir, {
          maxEvents: 3,
          maxBytes: 1_000_000,
        });
        expect(manager.getBranch().some((entry) => entry.id === requestFromEntryId)).toBe(false);
        await manager.appendMessageAsync(
          Object.assign(makeUserMessage("Worker update", 4), {
            provenance: { kind: "inter_session" },
          }),
        );
        if (kind === "steering") {
          await manager.appendMessageAsync(makeUserMessage(steering, 5));
        }
      }
      const toolCallId = `review-${generation}`;
      await manager.appendMessageAsync(
        createAssistant(testModel, [
          { type: "toolCall", id: toolCallId, name: "read", arguments: {} },
        ]),
      );
      await manager.appendMessageAsync({
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "Review continues.".repeat(50) }],
        isError: false,
        timestamp: 6,
      });
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { reserveTokens: 1024, keepRecentTokens: 1 },
          retry: { enabled: false },
        }),
      });
      try {
        if (generation > 0) {
          await expect(
            session[agentSessionAutomaticCompaction](undefined, "unresolved", "deterministic", {
              pendingUserEntryId: requestFromEntryId,
            }),
          ).rejects.toThrow("find the admitted pending user request");
        }
        const outcome = await session[agentSessionAutomaticCompaction](
          undefined,
          "unresolved",
          "deterministic",
          { requestFromEntryId },
        );
        expect(outcome.status).toBe("completed");
        if (outcome.status !== "completed") {
          throw new Error("Expected committed recovery boundary");
        }
        const expectedRequest =
          kind === "internal"
            ? undefined
            : generation > 0 && kind === "steering"
              ? steering
              : request;
        expect(parseCompactionDetails(outcome.result.details)?.latestUnresolvedUserRequest).toBe(
          expectedRequest,
        );
        expect(outcome.result.summary.includes("## Latest unresolved user request")).toBe(
          kind !== "internal",
        );
      } finally {
        session.dispose();
      }
    }
  },
);
