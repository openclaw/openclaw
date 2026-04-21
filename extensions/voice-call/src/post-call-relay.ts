import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SessionEntry } from "../api.js";
import type { VoiceCallConfig, VoiceCallPostCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { resolveVoiceResponseModel } from "./response-model.js";
import type { CallRecord, TranscriptEntry } from "./types.js";

export type PostCallRelayDeps = {
  voiceConfig: VoiceCallConfig;
  coreConfig: CoreConfig;
  agentRuntime: CoreAgentDeps;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

const DEFAULT_INSTRUCTION_TEMPLATE = [
  "A voice phone call just ended. Read the transcript above in full.",
  "Extract any commitments, requests, follow-ups, or information worth",
  "remembering. When appropriate, persist them to memory using the tools",
  "available to you. Then send the operator a concise confirmation message",
  "via {{channel}} summarizing what you captured and your plan of action.",
  "Do NOT call the operator back unless they explicitly asked on the call.",
].join(" ");

function formatDuration(startedAt: number, endedAt: number | undefined): string {
  if (!endedAt || endedAt <= startedAt) {
    return "<1s";
  }
  const totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function speakerLabel(speaker: TranscriptEntry["speaker"]): string {
  switch (speaker) {
    case "user":
      return "Caller";
    case "bot":
      return "Assistant";
    default:
      return "System";
  }
}

export function formatTranscriptForRelay(call: CallRecord): {
  header: string;
  body: string;
} {
  const iso = new Date(call.endedAt ?? Date.now()).toISOString();
  const duration = formatDuration(call.startedAt, call.endedAt);
  const directionLabel = call.direction === "outbound" ? "outbound" : "inbound";
  const counterparty = call.direction === "outbound" ? call.to : call.from;
  const header = `[VOICE CALL ENDED · ${iso} · ${directionLabel} · duration ${duration} · counterparty ${counterparty}]`;

  const lines = call.transcript
    .filter((entry) => entry.text?.trim())
    .map((entry) => `${speakerLabel(entry.speaker)}: ${entry.text.trim()}`);
  const body = lines.length > 0 ? lines.join("\n") : "(no spoken content captured)";
  return { header, body };
}

function buildInstruction(postCall: VoiceCallPostCallConfig): string {
  if (postCall.instruction && postCall.instruction.trim().length > 0) {
    return postCall.instruction;
  }
  const channel = postCall.channelMention?.trim() || "the configured channel";
  return DEFAULT_INSTRUCTION_TEMPLATE.replace("{{channel}}", channel);
}

/**
 * Create a post-call transcript relay hook suitable for installation on the
 * CallManager. The returned function can be passed as `onCallEnded`. It
 * never throws — any dispatch error is logged and swallowed so the manager
 * lifecycle stays clean.
 */
export function createPostCallRelayHook(deps: PostCallRelayDeps): (call: CallRecord) => void {
  const log = deps.logger ?? console;
  return (call: CallRecord): void => {
    const postCall = deps.voiceConfig.postCall;
    if (!postCall.enabled) {
      return;
    }
    const meaningfulEntries = call.transcript.filter(
      (entry) => entry.text?.trim().length && entry.speaker !== undefined,
    );
    if (meaningfulEntries.length < postCall.minTranscriptEntries) {
      log.info?.(
        `[voice-call] Post-call relay skipped for ${call.callId}: ${meaningfulEntries.length} entries < minimum ${postCall.minTranscriptEntries}`,
      );
      return;
    }

    // Fire-and-forget. The manager lifecycle must not wait on the agent task
    // completing, and we don't want to hold onto an active call record while
    // the agent reasons.
    void dispatchPostCallRelay(call, deps).catch((err) => {
      log.warn?.(
        `[voice-call] Post-call relay dispatch failed for ${call.callId}: ${formatErrorMessage(err)}`,
      );
    });
  };
}

async function dispatchPostCallRelay(call: CallRecord, deps: PostCallRelayDeps): Promise<void> {
  const { voiceConfig, coreConfig, agentRuntime, logger } = deps;
  const log = logger ?? console;
  const postCall = voiceConfig.postCall;

  const { header, body } = formatTranscriptForRelay(call);
  const instruction = buildInstruction(postCall);
  const userMessage = `${header}\n\nTRANSCRIPT:\n${body}\n\nINSTRUCTION: ${instruction}`;

  const agentId = "main";

  // Reuse the existing voice-call session routing (voice:<phone>) so the
  // post-call task lands on the same Pi session the in-call responder used.
  // This keeps memory lookups/session continuity aligned across the call.
  const counterparty = call.direction === "outbound" ? call.to : call.from;
  const normalizedPhone = counterparty.replace(/\D/g, "") || call.callId;
  const sessionKey = `voice:${normalizedPhone}`;

  const storePath = agentRuntime.session.resolveStorePath(coreConfig.session?.store, { agentId });
  const agentDir = agentRuntime.resolveAgentDir(coreConfig, agentId);
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(coreConfig, agentId);
  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  const sessionStore = agentRuntime.session.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;
  if (!sessionEntry) {
    sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: now };
    sessionStore[sessionKey] = sessionEntry;
    await agentRuntime.session.saveSessionStore(storePath, sessionStore);
  }
  const sessionFile = agentRuntime.session.resolveSessionFilePath(
    sessionEntry.sessionId,
    sessionEntry,
    {
      agentId,
    },
  );

  const { provider, model } = resolveVoiceResponseModel({ voiceConfig, agentRuntime });
  const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg: coreConfig, provider, model });
  const runId = `voice-post-call:${call.callId}:${now}`;

  log.info?.(`[voice-call] Dispatching post-call relay for ${call.callId} (session ${sessionKey})`);

  await agentRuntime.runEmbeddedPiAgent({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    messageProvider: "voice",
    sessionFile,
    workspaceDir,
    config: coreConfig,
    prompt: userMessage,
    provider,
    model,
    thinkLevel,
    verboseLevel: "off",
    timeoutMs: postCall.timeoutMs,
    runId,
    lane: "voice",
    agentDir,
  });
}
