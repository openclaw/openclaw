import path from "node:path";
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

export function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

export function appendMessages(
  sessionManager: SessionManager,
  messages: AppendMessage[],
): string[] {
  return messages.map((message) => sessionManager.appendMessage(message));
}

export function createTextContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function useTranscriptRewriteTargets(
  registerCleanup: (cleanup: () => Promise<void>) => unknown,
) {
  const lifetime = createFixtureLifetime();
  const tempDirs = useAutoCleanupTempDirTracker((removeDirectories) => {
    registerCleanup(async () => {
      void lifetime.verifyCleanup(async () => {
        const failures: unknown[] = [];
        for (const directory of tempDirs.dirs) {
          for (const settle of [
            () => waitForSessionTranscriptIndexReconcilesInStateDir(directory),
            () => closeOpenClawAgentDatabasesAsync(directory),
          ]) {
            try {
              await settle();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Transcript rewrite fixture cleanup failed");
        }
        removeDirectories();
      });
      await lifetime.cleanup();
    });
  });
  return async (sessionId: string) => {
    const directory = tempDirs.make(`openclaw-${sessionId}-`);
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(directory, "sessions.json"),
    };
    await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
    return { directory, target };
  };
}
