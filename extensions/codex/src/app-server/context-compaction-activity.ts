import { createHash } from "node:crypto";
import {
  embeddedAgentLog,
  formatErrorMessage,
  type CompactEmbeddedAgentSessionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const CONTEXT_COMPACTION_CUSTOM_TYPE = "openclaw.context-compaction";

export function fingerprintCodexContextCompaction(params: {
  threadId: string;
  turnId: string;
  item: unknown;
}): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([params.threadId, params.turnId, params.item]))
    .digest("hex")}`;
}

export function buildCodexContextCompactionActivity(params: {
  runId?: string;
  threadId: string;
  turnId: string;
  itemId: string;
  timestamp: number;
}) {
  const activityId = `codex-context-compaction:${params.threadId}:${params.turnId}:${params.itemId}`;
  return attachCodexMirrorIdentity(
    {
      role: "custom" as const,
      customType: CONTEXT_COMPACTION_CUSTOM_TYPE,
      content: "Context compacted",
      display: true,
      excludeFromContext: true,
      details: {
        kind: "context_compaction",
        backend: "codex-app-server",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        ...(params.runId ? { runId: params.runId } : {}),
      },
      __openclaw: { itemId: params.itemId, ...(params.runId ? { runId: params.runId } : {}) },
      timestamp: params.timestamp,
      idempotencyKey: activityId,
    },
    activityId,
  );
}

/** Persists manual compaction, which runs outside a provider attempt and has no host capability. */
export async function persistCodexContextCompactionActivity(params: {
  sessionTarget?: CompactEmbeddedAgentSessionParams["sessionTarget"];
  config?: CompactEmbeddedAgentSessionParams["config"];
  cwd?: string;
  runId?: string;
  threadId: string;
  turnId: string;
  itemId: string;
  timestamp: number;
}): Promise<void> {
  const target = params.sessionTarget;
  if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
    return;
  }
  const transcriptTarget = {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
  const eventId = `codex-context-compaction:${params.threadId}:${params.turnId}:${params.itemId}`;
  try {
    const appended = await appendSessionTranscriptMessageByIdentity({
      ...transcriptTarget,
      config: params.config,
      cwd: params.cwd,
      eventId,
      message: buildCodexContextCompactionActivity(params),
    });
    if (!appended?.appended) {
      return;
    }
    await publishSessionTranscriptUpdateByIdentity({
      ...transcriptTarget,
      update: {
        message: appended.message,
        messageId: appended.messageId,
        ...(params.runId ? { runId: params.runId } : {}),
      },
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to persist codex context compaction activity", {
      error: formatErrorMessage(error),
      itemId: params.itemId,
    });
  }
}
