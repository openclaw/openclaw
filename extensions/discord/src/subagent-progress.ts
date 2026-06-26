// Discord plugin module implements source-message subagent progress feedback.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { reactMessageDiscord, removeReactionDiscord } from "./send.reactions.js";
import { sendTypingDiscord } from "./send.typing.js";

const DEFAULT_RUNNING_ORDINALS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const DEFAULT_FAILURE_EMOJI = "🔴";
const DEFAULT_TYPING_INTERVAL_MS = 8_500;
const DEFAULT_TYPING_MAX_DURATION_MS = 60 * 60_000;

type DiscordSubagentRequester = {
  channel?: string;
  accountId?: string;
  to?: string;
  sourceTo?: string;
  threadId?: string | number;
  messageId?: string | number;
};

type DiscordSubagentSpawnedEvent = {
  runId?: string;
  requester?: DiscordSubagentRequester;
};

type DiscordSubagentEndedEvent = {
  runId?: string;
  outcome?: string;
  requester?: DiscordSubagentRequester;
};

type TrackerConfig = {
  enabled: boolean;
  reactionsEnabled: boolean;
  typingEnabled: boolean;
  runningOrdinals: string[];
  failureEmoji: string;
  typingIntervalMs: number;
  typingMaxDurationMs: number;
};

type ParentTracker = {
  accountId: string;
  channelId: string;
  typingChannelId: string;
  messageId: string;
  activeRunIds: Set<string>;
  runningEmoji?: string;
  typingTimer?: ReturnType<typeof setInterval>;
  typingExpiresAt?: number;
};

const trackers = new Map<string, ParentTracker>();

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolveTrackerConfig(accountConfig: {
  subagentProgress?: {
    enabled?: boolean;
    reactions?: {
      enabled?: boolean;
      runningOrdinals?: string[];
      failure?: string;
    };
    typing?: {
      enabled?: boolean;
      intervalMs?: number;
      maxDurationMs?: number;
    };
  };
}): TrackerConfig {
  const progress = accountConfig.subagentProgress;
  const runningOrdinals =
    progress?.reactions?.runningOrdinals?.filter((emoji) => emoji.trim()) ?? [];
  return {
    enabled: progress?.enabled === true,
    reactionsEnabled: progress?.reactions?.enabled !== false,
    typingEnabled: progress?.typing?.enabled !== false,
    runningOrdinals: runningOrdinals.length > 0 ? runningOrdinals : DEFAULT_RUNNING_ORDINALS,
    failureEmoji: progress?.reactions?.failure?.trim() || DEFAULT_FAILURE_EMOJI,
    typingIntervalMs: normalizePositiveInteger(
      progress?.typing?.intervalMs,
      DEFAULT_TYPING_INTERVAL_MS,
    ),
    typingMaxDurationMs: normalizePositiveInteger(
      progress?.typing?.maxDurationMs,
      DEFAULT_TYPING_MAX_DURATION_MS,
    ),
  };
}

function channelIdFromTarget(target?: string): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("channel:") ? trimmed.slice("channel:".length).trim() : trimmed;
}

function resolveProgressTarget(
  event: { requester?: DiscordSubagentRequester },
  accountId: string,
):
  | {
      key: string;
      channelId: string;
      typingChannelId: string;
      messageId: string;
    }
  | undefined {
  const channel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (channel !== "discord") {
    return undefined;
  }
  const channelId =
    channelIdFromTarget(event.requester?.sourceTo) ?? channelIdFromTarget(event.requester?.to);
  const messageId = normalizeOptionalStringifiedId(event.requester?.messageId);
  if (!channelId || !messageId) {
    return undefined;
  }
  const typingChannelId = normalizeOptionalStringifiedId(event.requester?.threadId) ?? channelId;
  return {
    key: `${accountId}:${channelId}:${typingChannelId}:${messageId}`,
    channelId,
    typingChannelId,
    messageId,
  };
}

function logProgressFailure(api: DiscordSubagentProgressApi, message: string, err: unknown) {
  api.logger.debug?.(`discord subagent progress ${message}: ${summarizeError(err)}`);
}

async function addReaction(
  api: DiscordSubagentProgressApi,
  tracker: Pick<ParentTracker, "accountId" | "channelId" | "messageId">,
  emoji: string,
): Promise<boolean> {
  try {
    await reactMessageDiscord(tracker.channelId, tracker.messageId, emoji, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
    return true;
  } catch (err) {
    logProgressFailure(api, "reaction add failed", err);
    return false;
  }
}

async function removeReaction(
  api: DiscordSubagentProgressApi,
  tracker: Pick<ParentTracker, "accountId" | "channelId" | "messageId">,
  emoji: string | undefined,
): Promise<boolean> {
  if (!emoji) {
    return true;
  }
  try {
    await removeReactionDiscord(tracker.channelId, tracker.messageId, emoji, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
    return true;
  } catch (err) {
    logProgressFailure(api, "reaction remove failed", err);
    return false;
  }
}

async function sendTyping(api: DiscordSubagentProgressApi, tracker: ParentTracker) {
  try {
    await sendTypingDiscord(tracker.typingChannelId, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
  } catch (err) {
    logProgressFailure(api, "typing failed", err);
  }
}

function stopTyping(tracker: ParentTracker) {
  if (tracker.typingTimer) {
    clearInterval(tracker.typingTimer);
    tracker.typingTimer = undefined;
  }
  tracker.typingExpiresAt = undefined;
}

function startTyping(
  api: DiscordSubagentProgressApi,
  tracker: ParentTracker,
  config: TrackerConfig,
) {
  if (!config.typingEnabled || tracker.typingTimer) {
    return;
  }
  tracker.typingExpiresAt = Date.now() + config.typingMaxDurationMs;
  void sendTyping(api, tracker);
  tracker.typingTimer = setInterval(() => {
    if (tracker.activeRunIds.size <= 0 || (tracker.typingExpiresAt ?? 0) <= Date.now()) {
      stopTyping(tracker);
      return;
    }
    void sendTyping(api, tracker);
  }, config.typingIntervalMs);
  tracker.typingTimer.unref?.();
}

function cleanupTracker(key: string, tracker: ParentTracker) {
  if (tracker.activeRunIds.size > 0) {
    return;
  }
  stopTyping(tracker);
  trackers.delete(key);
}

function runningEmojiForActiveCount(
  activeCount: number,
  config: TrackerConfig,
): string | undefined {
  if (activeCount <= 0 || config.runningOrdinals.length <= 0) {
    return undefined;
  }
  const index = Math.min(activeCount, config.runningOrdinals.length) - 1;
  return config.runningOrdinals[index];
}

async function updateRunningReaction(
  api: DiscordSubagentProgressApi,
  tracker: ParentTracker,
  config: TrackerConfig,
): Promise<boolean> {
  if (!config.reactionsEnabled) {
    return true;
  }
  const previousEmoji = tracker.runningEmoji;
  const nextEmoji = runningEmojiForActiveCount(tracker.activeRunIds.size, config);
  if (previousEmoji === nextEmoji) {
    return true;
  }
  const removed = await removeReaction(api, tracker, previousEmoji);
  const added = nextEmoji ? await addReaction(api, tracker, nextEmoji) : true;
  if (added) {
    tracker.runningEmoji = nextEmoji;
  }
  return removed && added;
}

async function cleanupSourceMessageFromEvent(
  api: DiscordSubagentProgressApi,
  target: {
    channelId: string;
    messageId: string;
  },
  accountId: string,
  config: TrackerConfig,
  event: DiscordSubagentEndedEvent,
): Promise<boolean> {
  if (!config.reactionsEnabled) {
    return true;
  }
  const tracker = {
    accountId,
    channelId: target.channelId,
    messageId: target.messageId,
  };
  let handled = true;
  for (const emoji of new Set(config.runningOrdinals)) {
    handled = (await removeReaction(api, tracker, emoji)) && handled;
  }
  if (event.outcome && event.outcome !== "ok") {
    handled = (await addReaction(api, tracker, config.failureEmoji)) && handled;
  }
  return handled;
}

type DiscordSubagentProgressApi = {
  config: OpenClawConfig;
  logger: {
    debug?: (message: string) => void;
  };
};

export async function handleDiscordSubagentProgressSpawned(
  api: DiscordSubagentProgressApi,
  event: DiscordSubagentSpawnedEvent,
) {
  const runId = event.runId?.trim();
  if (!runId) {
    return;
  }
  const account = resolveDiscordAccount({
    cfg: api.config,
    accountId: event.requester?.accountId,
  });
  if (!account.enabled) {
    return;
  }
  const config = resolveTrackerConfig(account.config);
  if (!config.enabled) {
    return;
  }
  const target = resolveProgressTarget(event, account.accountId);
  if (!target) {
    return;
  }
  let tracker = trackers.get(target.key);
  if (!tracker) {
    tracker = {
      accountId: account.accountId,
      channelId: target.channelId,
      typingChannelId: target.typingChannelId,
      messageId: target.messageId,
      activeRunIds: new Set(),
    };
    trackers.set(target.key, tracker);
  }
  if (tracker.activeRunIds.has(runId)) {
    return;
  }
  tracker.activeRunIds.add(runId);
  await updateRunningReaction(api, tracker, config);
  startTyping(api, tracker, config);
}

export async function handleDiscordSubagentProgressEnded(
  api: DiscordSubagentProgressApi,
  event: DiscordSubagentEndedEvent,
): Promise<boolean> {
  const runId = event.runId?.trim();
  if (!runId) {
    return true;
  }
  const account = resolveDiscordAccount({
    cfg: api.config,
    accountId: event.requester?.accountId,
  });
  if (!account.enabled) {
    return true;
  }
  const config = resolveTrackerConfig(account.config);
  if (!config.enabled) {
    return true;
  }
  const target = resolveProgressTarget(event, account.accountId);
  if (!target) {
    return true;
  }
  const tracker = trackers.get(target.key);
  if (!tracker || !tracker.activeRunIds.has(runId)) {
    return cleanupSourceMessageFromEvent(api, target, account.accountId, config, event);
  }
  tracker.activeRunIds.delete(runId);
  let handled = await updateRunningReaction(api, tracker, config);
  if (config.reactionsEnabled && event.outcome && event.outcome !== "ok") {
    handled = (await addReaction(api, tracker, config.failureEmoji)) && handled;
  }
  cleanupTracker(target.key, tracker);
  return handled;
}

export function resetDiscordSubagentProgressForTest() {
  for (const tracker of trackers.values()) {
    stopTyping(tracker);
  }
  trackers.clear();
}
