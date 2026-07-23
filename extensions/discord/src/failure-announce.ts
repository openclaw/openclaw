// Discord plugin module sends concise user-visible failure notes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createReusableDiscordReplyReference } from "./reply-reference.js";
import { sendMessageDiscord } from "./send.js";

const ANNOUNCED_FAILURE_TTL_MS = 60 * 60_000;
const MAX_ANNOUNCED_FAILURES = 4_096;

const announcedFailures = new Map<string, number>();

type DiscordFailureLogger = {
  debug?: (message: string) => void;
};

type DiscordFailureOutcome = "error" | "timeout" | "killed" | "unknown";

function pruneAnnouncedFailures(now: number) {
  for (const [key, expiresAt] of announcedFailures) {
    if (expiresAt > now) {
      continue;
    }
    announcedFailures.delete(key);
  }
  while (announcedFailures.size >= MAX_ANNOUNCED_FAILURES) {
    const oldest = announcedFailures.keys().next().value;
    if (!oldest) {
      break;
    }
    announcedFailures.delete(oldest);
  }
}

function markAnnounced(key: string): boolean {
  const now = Date.now();
  pruneAnnouncedFailures(now);
  if (announcedFailures.has(key)) {
    return false;
  }
  announcedFailures.set(key, now + ANNOUNCED_FAILURE_TTL_MS);
  return true;
}

function normalizeFailureOutcome(outcome: string): DiscordFailureOutcome {
  return outcome === "timeout" || outcome === "killed" || outcome === "unknown"
    ? outcome
    : "error";
}

function formatFailureNextStep(outcome: DiscordFailureOutcome): string {
  if (outcome === "timeout") {
    return "Gateway was busy -- try again in a minute.";
  }
  return "Please retry the request.";
}

function logAnnounceFailure(
  logger: DiscordFailureLogger | undefined,
  action: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  logger?.debug?.(`discord failure announce ${action} failed: ${message}`);
}

async function sendDedupedDiscordFailureNote(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  channelId: string;
  messageId: string;
  dedupeKey: string;
  text: string;
  logger?: DiscordFailureLogger;
}) {
  const channelId = params.channelId.trim();
  const messageId = params.messageId.trim();
  if (!channelId || !messageId || !markAnnounced(params.dedupeKey)) {
    return false;
  }
  try {
    await sendMessageDiscord(`channel:${channelId}`, params.text, {
      cfg: params.cfg,
      accountId: params.accountId,
      reply: createReusableDiscordReplyReference(messageId),
    });
    return true;
  } catch (error) {
    logAnnounceFailure(params.logger, "send", error);
    return false;
  }
}

export function formatDiscordSubagentFailureText(params: {
  outcome: string;
  agentId?: string;
  runId?: string;
}) {
  const outcome = normalizeFailureOutcome(params.outcome);
  const agentId = params.agentId?.trim();
  const runId = params.runId?.trim();
  const workerLabel = agentId
    ? `Sub-agent worker ${agentId}`
    : runId
      ? `A sub-agent worker (${runId})`
      : "A sub-agent worker";
  return [`${workerLabel} failed.`, `Outcome: ${outcome}.`, formatFailureNextStep(outcome)].join(
    "\n",
  );
}

export async function sendDiscordSubagentFailureAnnounce(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  channelId: string;
  messageId: string;
  runId: string;
  outcome: string;
  agentId?: string;
  logger?: DiscordFailureLogger;
}) {
  const outcome = normalizeFailureOutcome(params.outcome);
  return await sendDedupedDiscordFailureNote({
    cfg: params.cfg,
    accountId: params.accountId,
    channelId: params.channelId,
    messageId: params.messageId,
    dedupeKey: [
      "subagent",
      params.accountId ?? "",
      params.channelId,
      params.messageId,
      params.runId,
    ].join(":"),
    text: formatDiscordSubagentFailureText({
      outcome,
      agentId: params.agentId,
      runId: params.runId,
    }),
    logger: params.logger,
  });
}

export function formatDiscordHandlerTimeoutFailureText() {
  return [
    "Discord gateway was busy and timed out before handling this message.",
    "Please retry the request in a minute.",
  ].join("\n");
}

export async function sendDiscordHandlerTimeoutFailureAnnounce(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  channelId: string;
  messageId: string;
  logger?: DiscordFailureLogger;
}) {
  return await sendDedupedDiscordFailureNote({
    cfg: params.cfg,
    accountId: params.accountId,
    channelId: params.channelId,
    messageId: params.messageId,
    dedupeKey: ["handler-timeout", params.accountId ?? "", params.channelId, params.messageId].join(
      ":",
    ),
    text: formatDiscordHandlerTimeoutFailureText(),
    logger: params.logger,
  });
}

export function resetDiscordFailureAnnounceForTest() {
  announcedFailures.clear();
}
