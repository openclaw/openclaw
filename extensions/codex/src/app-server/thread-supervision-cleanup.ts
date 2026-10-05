import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerPendingSupervisionBranch } from "./session-binding.js";

export function withPendingSupervisionCleanup(
  pending: CodexAppServerPendingSupervisionBranch,
  cleanupThreadIds: string[],
): CodexAppServerPendingSupervisionBranch {
  return {
    sourceThreadId: pending.sourceThreadId,
    ...(pending.connectionFingerprint
      ? { connectionFingerprint: pending.connectionFingerprint }
      : {}),
    ...(pending.lastTurnId ? { lastTurnId: pending.lastTurnId } : {}),
    ...(cleanupThreadIds.length > 0 ? { cleanupThreadIds } : {}),
  };
}

export async function cleanPendingSupervisionArtifacts(
  client: CodexAppServerClient,
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<{ remaining: string[] }> {
  const remaining: string[] = [];
  for (const threadId of pending.cleanupThreadIds ?? []) {
    if (!(await archiveSupervisionArtifact(client, threadId))) {
      remaining.push(threadId);
    }
  }
  return { remaining };
}

async function archiveSupervisionArtifact(
  client: CodexAppServerClient,
  threadId: string,
): Promise<boolean> {
  try {
    await client.request(
      "thread/archive",
      { threadId },
      { timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    const message = formatErrorMessage(error).toLowerCase();
    if (
      message.includes("no rollout found for thread id") ||
      message.includes("thread not found") ||
      message.includes("already archived")
    ) {
      return true;
    }
    await unsubscribeCodexThreadBestEffort(client, {
      threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    embeddedAgentLog.warn("failed to archive temporary Codex supervision thread", {
      threadId,
      error,
    });
    return false;
  }
}
