import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readTranscriptStorageRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it("never replays conversation before a prior compaction whose retained entry precedes its marker", () =>
  withSessionState(
    "boundary-proof",
    async ({ scope, state }) => {
      const dir = state.root;
      await upsertSessionEntryCore(scope, {
        sessionFile: formatSqliteSessionFileMarker(scope),
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
    },
    { storePath: (state) => path.join(state.root, "sessions.json") },
  ));

it.each(["human", "internal", "steering"] as const)(
  "preserves the %s request selection through repeated semantic-window recovery",
  (kind) =>
    withSessionState(`request-recovery-${kind}`, async ({ scope, state }) => {
      const request = "Review the patch; do not deploy it.";
      const steering = "Also check the upgrade path.";
      let manager = await SessionManager.openAsync(scope, state.root, { compaction: true });
      await manager.appendMessageAsync(makeUserMessage("Completed earlier human task", 1));
      await manager.appendMessageAsync(createAssistant(testModel, "Completed."));
      const requestFromEntryId = await manager.appendMessageAsync({
        ...makeUserMessage(request, 3),
        ...(kind === "internal" ? { provenance: { kind: "inter_session" as const } } : {}),
      });
      for (let generation = 0; generation < 2; generation++) {
        if (generation > 0) {
          // Use the production recovery reader: the admitted row is now archived.
          manager = await SessionManager.openAsync(scope, state.root, { compaction: true });
          expect(manager.getBranch().some((entry) => entry.id === requestFromEntryId)).toBe(false);
          const observation: PersistedUserTurnMessage = {
            ...makeUserMessage("Worker update", 4),
            provenance: { kind: "inter_session" },
          };
          await manager.appendMessageAsync(observation);
        }
        if (kind === "steering" && generation > 0) {
          await manager.appendMessageAsync(makeUserMessage(steering, 5));
        }
        const expectedRequest =
          kind === "internal"
            ? undefined
            : generation > 0 && kind === "steering"
              ? steering
              : request;
        const callId = `read-${generation}`;
        await manager.appendMessageAsync(
          createAssistant(testModel, [
            { type: "toolCall", id: callId, name: "read", arguments: {} },
          ]),
        );
        await manager.appendMessageAsync(
          makeTextToolResult(callId, "read", "Patch contents", false, 5),
        );
        await manager.appendMessageAsync(createAssistant(testModel, "Review continues."));
        const { session } = await createTestSession({
          sessionManager: manager,
          settingsManager: SettingsManager.inMemory({
            compaction: { reserveTokens: 1_024, keepRecentTokens: 1 },
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
            throw new Error("Expected a committed recovery boundary");
          }
          expect(outcome.result.details).toMatchObject({
            readFiles: [],
            modifiedFiles: [],
            ...(expectedRequest ? { latestUnresolvedUserRequest: expectedRequest } : {}),
          });
          expect(outcome.result.summary.includes("## Latest unresolved user request")).toBe(
            kind !== "internal",
          );
        } finally {
          session.dispose();
        }
      }
    }),
);
