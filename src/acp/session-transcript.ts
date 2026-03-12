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
  });
}

async function persistAcpTranscriptMessages(
  params: PersistAcpTranscriptParams & {
    promptText: string;
    replyText: string;
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
  if (promptText && shouldAppendPrompt(sessionManager, promptText, params.inputProvenance)) {
    const userMessage = applyInputProvenanceToUserMessage(
      {
        role: "user",
        content: promptText,
        timestamp: Date.now(),
      } as AgentMessage,
      params.inputProvenance,
    );
    sessionManager.appendMessage(userMessage as Parameters<typeof sessionManager.appendMessage>[0]);
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
    forcePersistPromptOnlyTranscript(sessionManager);
  }

  if (changed) {
    emitSessionTranscriptUpdate(sessionFile);
  }
  return sessionEntry;
}

function shouldAppendPrompt(
  sessionManager: ReturnType<typeof SessionManager.open>,
  promptText: string,
  inputProvenance: InputProvenance | undefined,
): boolean {
  const lastMessage = getTranscriptMessages(sessionManager).at(-1);
  if (!lastMessage || lastMessage.role !== "user") {
    return true;
  }
  if (typeof lastMessage.content !== "string") {
    return true;
  }
  if (normalizePromptForDedup(lastMessage.content) !== normalizePromptForDedup(promptText)) {
    return true;
  }
  return !sameInputProvenance(
    (lastMessage as { provenance?: unknown }).provenance,
    inputProvenance,
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

function forcePersistPromptOnlyTranscript(
  sessionManager: ReturnType<typeof SessionManager.open>,
): void {
  const manager = sessionManager as unknown as {
    isPersisted?: () => boolean;
    _rewriteFile?: () => void;
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
  manager._rewriteFile();
}
