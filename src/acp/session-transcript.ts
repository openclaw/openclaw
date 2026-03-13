import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { prepareSessionManagerForRun } from "../agents/pi-embedded-runner/session-manager-init.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  applyInputProvenanceToUserMessage,
  normalizeInputProvenance,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*]\s*/;
const log = createSubsystemLogger("acp/session-transcript");
const ACP_SPAWN_SEED_CUSTOM_TYPE = "openclaw.acp_spawn_seed";

export const ACP_TRANSCRIPT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

type PersistAcpTranscriptParams = {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  inputProvenance?: InputProvenance;
};

export async function persistAcpPromptTranscript(
  params: PersistAcpTranscriptParams & {
    promptText: string;
  },
): Promise<SessionEntry | undefined> {
  return await persistAcpTranscriptMessages({
    ...params,
    seedSpawnPrompt: true,
    replyText: "",
  });
}

export async function persistAcpTurnTranscript(
  params: PersistAcpTranscriptParams & {
    body: string;
    finalText: string;
  },
): Promise<SessionEntry | undefined> {
  return await persistAcpTranscriptMessages({
    ...params,
    promptText: params.body,
    replyText: params.finalText,
    seedSpawnPrompt: false,
  });
}

async function persistAcpTranscriptMessages(
  params: PersistAcpTranscriptParams & {
    promptText: string;
    replyText: string;
    seedSpawnPrompt: boolean;
  },
): Promise<SessionEntry | undefined> {
  const promptText = params.promptText;
  const replyText = params.replyText;
  if (!promptText && !replyText) {
    return params.sessionEntry;
  }

  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    agentId: params.sessionAgentId,
    threadId: params.threadId,
  });
  const hadSessionFile = await fs
    .access(sessionFile)
    .then(() => true)
    .catch(() => false);
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: params.sessionCwd,
  });

  let changed = false;
  const consumedPendingSpawnSeedReplay =
    !params.seedSpawnPrompt &&
    Boolean(promptText) &&
    consumePendingSpawnSeedReplayDedup(sessionManager, promptText, params.inputProvenance);
  if (consumedPendingSpawnSeedReplay) {
    // Persist the consumed seed marker before any later assistant append so the
    // dedupe window closes even when the replayed turn produces no text.
    await forcePersistPromptOnlyTranscript(sessionManager);
  }
  if (promptText && !consumedPendingSpawnSeedReplay) {
    const userMessage = applyInputProvenanceToUserMessage(
      {
        role: "user",
        content: promptText,
        timestamp: Date.now(),
      } as AgentMessage,
      params.inputProvenance,
    );
    sessionManager.appendMessage(userMessage as Parameters<typeof sessionManager.appendMessage>[0]);
    if (params.seedSpawnPrompt) {
      sessionManager.appendCustomEntry(ACP_SPAWN_SEED_CUSTOM_TYPE, {
        pendingReplayDedup: true,
      });
    }
    changed = true;
  }

  if (replyText) {
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "acp-runtime",
      usage: ACP_TRANSCRIPT_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    changed = true;
  }

  if (changed && promptText && !replyText) {
    await forcePersistPromptOnlyTranscript(sessionManager);
  }

  if (changed) {
    emitSessionTranscriptUpdate(sessionFile);
  }
  return sessionEntry;
}

function consumePendingSpawnSeedReplayDedup(
  sessionManager: ReturnType<typeof SessionManager.open>,
  promptText: string,
  inputProvenance: InputProvenance | undefined,
): boolean {
  // Only dedupe the replay of the one seeded `sessions_spawn` prompt. Once that
  // replay is consumed, later identical prompt-only retries must still persist.
  const leafEntry = sessionManager.getLeafEntry() as
    | {
        type?: string;
        customType?: string;
        data?: { pendingReplayDedup?: boolean };
      }
    | undefined;
  if (
    leafEntry?.type !== "custom" ||
    leafEntry.customType !== ACP_SPAWN_SEED_CUSTOM_TYPE ||
    leafEntry.data?.pendingReplayDedup !== true
  ) {
    return false;
  }
  const lastMessage = getTranscriptMessages(sessionManager).at(-1);
  if (!lastMessage || lastMessage.role !== "user") {
    return false;
  }
  if (typeof lastMessage.content !== "string") {
    return false;
  }
  if (normalizePromptForDedup(lastMessage.content) !== normalizePromptForDedup(promptText)) {
    return false;
  }
  if (!sameInputProvenance((lastMessage as { provenance?: unknown }).provenance, inputProvenance)) {
    return false;
  }
  leafEntry.data = { ...leafEntry.data, pendingReplayDedup: false };
  return true;
}

function sameInputProvenance(existing: unknown, incoming: InputProvenance | undefined): boolean {
  const normalizedExisting = normalizeInputProvenance(existing);
  const normalizedIncoming = normalizeInputProvenance(incoming);
  if (!normalizedExisting && !normalizedIncoming) {
    return true;
  }
  if (!normalizedExisting || !normalizedIncoming) {
    return false;
  }
  return (
    normalizedExisting.kind === normalizedIncoming.kind &&
    normalizedExisting.originSessionId === normalizedIncoming.originSessionId &&
    normalizedExisting.sourceSessionKey === normalizedIncoming.sourceSessionKey &&
    normalizedExisting.sourceChannel === normalizedIncoming.sourceChannel &&
    normalizedExisting.sourceTool === normalizedIncoming.sourceTool
  );
}

function getTranscriptMessages(
  sessionManager: ReturnType<typeof SessionManager.open>,
): AgentMessage[] {
  return sessionManager
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message);
}

function normalizePromptForDedup(text: string): string {
  return text.replace(TIMESTAMP_ENVELOPE_PATTERN, "").trim();
}

async function forcePersistPromptOnlyTranscript(
  sessionManager: ReturnType<typeof SessionManager.open>,
): Promise<void> {
  const manager = sessionManager as unknown as {
    isPersisted?: () => boolean;
    _rewriteFile?: () => Promise<void> | void;
    flushed?: boolean;
  };
  if (typeof manager.isPersisted === "function" && !manager.isPersisted()) {
    return;
  }
  // pi-coding-agent keeps prompt-only sessions in memory until the first assistant
  // message arrives. ACP spawn needs the initial task on disk immediately.
  if (typeof manager._rewriteFile !== "function") {
    log.warn(
      "ACP prompt-only transcript flush skipped because SessionManager._rewriteFile is unavailable",
    );
    return;
  }
  await manager._rewriteFile();
  manager.flushed = true;
}
