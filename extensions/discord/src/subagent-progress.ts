// Discord plugin module maps portable subagent progress onto source-message feedback.
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { reactMessageDiscord, removeReactionDiscord } from "./send.reactions.js";
import { sendTypingDiscord } from "./send.typing.js";

const RUNNING_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const FAILURE_EMOJI = "🔴";
const TYPING_INTERVAL_MS = 8_500;
const TYPING_TTL_MS = 60 * 60_000;
const PROGRESS_STORE_TTL_MS = 7 * 24 * 60 * 60_000;
const TERMINAL_TOMBSTONE_TTL_MS = 60 * 60_000;
const TERMINAL_LOOKUP_RETRY_MS = 1_000;
const TERMINAL_RETRY_MAX_DELAY_MS = 60 * 60_000;
const TERMINAL_RETRY_MAX_ATTEMPTS = 12;
const STARTUP_RETRY_MAX_ATTEMPTS = 12;
const MAX_TRACKED_RUNS = 4_096;

type SubagentProgressEvent =
  | {
      phase: "started";
      runId: string;
      requester?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
        channelId?: string | number;
        messageId?: string | number;
      };
    }
  | {
      phase: "ended";
      runId: string;
      outcome: "ok" | "error" | "timeout" | "killed" | "unknown";
      requester?: Extract<SubagentProgressEvent, { phase: "started" }>["requester"];
    };

type ProgressApi = {
  config: OpenClawConfig;
  logger: { debug?: (message: string) => void };
  runtime?: {
    state: {
      openKeyedStore<T>(options: {
        namespace: string;
        maxEntries: number;
        overflowPolicy: "reject-new";
        defaultTtlMs: number;
      }): PluginStateKeyedStore<T>;
    };
  };
};

type PersistedProgressRun = {
  /** Plugin SQLite ownership lets an ended run clean reactions after gateway restart. */
  key: string;
  accountId: string;
  channelId: string;
  messageId: string;
  status: "active" | "cleanup";
  runningEmoji?: string;
};

type ProgressTracker = {
  accountId: string;
  channelId: string;
  messageId: string;
  activeRunIds: Set<string>;
  persistedRunIds: Set<string>;
  runningEmoji?: string;
  runningEmojiConfirmed: boolean;
  reactionsEnabled: boolean;
  typingTimer?: ReturnType<typeof setInterval>;
  typingExpiresAt: number;
};

type ProgressStateForKeyResult =
  | { ok: true; activeRunIds: string[]; cleanupRunIds: string[]; ownedEmojis: string[] }
  | { ok: false };

type ProgressRunLookupResult =
  | { status: "found"; value: PersistedProgressRun }
  | { status: "missing" }
  | { status: "error" };

type PersistProgressResult = "persisted" | "terminal" | "conflict" | "error";

type PersistedReconciliationResult =
  | { ok: false }
  | {
      ok: true;
      activeRunIds: string[];
      reactionsEnabled: boolean;
      typingEnabled: boolean;
      runningEmoji?: string;
    };

const trackers = new Map<string, ProgressTracker>();
const trackerKeyByRunId = new Map<string, string>();
const trackerQueues = new Map<string, Promise<void>>();
const terminalRunIds = new Map<string, number>();
const terminalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const terminalRetryExpiresAt = new Map<string, number>();
const terminalRetryAttempts = new Map<string, number>();
const startupRecoveryRetries = new Map<
  ProgressApi,
  { attempts: number; timer?: ReturnType<typeof setTimeout> }
>();
let progressStores = new WeakMap<object, PluginStateKeyedStore<PersistedProgressRun> | null>();

function channelIdFromTarget(target?: string): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("channel:")) {
    return trimmed.slice("channel:".length).trim() || undefined;
  }
  return /^\d+$/u.test(trimmed) ? trimmed : undefined;
}

function resolveTarget(event: Extract<SubagentProgressEvent, { phase: "started" }>) {
  if (normalizeOptionalLowercaseString(event.requester?.channel) !== "discord") {
    return undefined;
  }
  const channelId =
    normalizeOptionalStringifiedId(event.requester?.channelId) ??
    channelIdFromTarget(event.requester?.to);
  const messageId = normalizeOptionalStringifiedId(event.requester?.messageId);
  if (!channelId || !messageId) {
    return undefined;
  }
  return { channelId, messageId };
}

function reservedReactionEmojis(config: OpenClawConfig, ackReaction?: string): Set<string> {
  const reserved = new Set<string>(Object.values(DEFAULT_EMOJIS));
  for (const emoji of Object.values(config.messages?.statusReactions?.emojis ?? {})) {
    if (emoji?.trim()) {
      reserved.add(emoji.trim());
    }
  }
  for (const emoji of [config.messages?.ackReaction, ackReaction]) {
    if (emoji?.trim()) {
      reserved.add(emoji.trim());
    }
  }
  for (const agent of config.agents?.list ?? []) {
    const emoji = agent.identity?.emoji?.trim();
    if (emoji) {
      reserved.add(emoji);
    }
  }
  return reserved;
}

function reactionsAreAvailable(config: OpenClawConfig, ackReaction?: string): boolean {
  const reserved = reservedReactionEmojis(config, ackReaction);
  return !RUNNING_EMOJIS.some((emoji) => reserved.has(emoji)) && !reserved.has(FAILURE_EMOJI);
}

function markRunTerminal(runId: string) {
  const now = Date.now();
  for (const [trackedRunId, expiresAt] of terminalRunIds) {
    if (expiresAt <= now) {
      terminalRunIds.delete(trackedRunId);
    }
  }
  terminalRunIds.set(runId, now + TERMINAL_TOMBSTONE_TTL_MS);
  if (terminalRunIds.size > MAX_TRACKED_RUNS) {
    const oldest = terminalRunIds.keys().next().value;
    if (oldest) {
      terminalRunIds.delete(oldest);
    }
  }
}

function isRunTerminal(runId: string): boolean {
  const expiresAt = terminalRunIds.get(runId);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    terminalRunIds.delete(runId);
    return false;
  }
  return true;
}

function clearTerminalRetry(runId: string) {
  const timer = terminalRetryTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
  }
  terminalRetryTimers.delete(runId);
  terminalRetryExpiresAt.delete(runId);
  terminalRetryAttempts.delete(runId);
}

function cancelTerminalRetryTimer(runId: string) {
  const timer = terminalRetryTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
  }
  terminalRetryTimers.delete(runId);
}

function getProgressStore(
  api: ProgressApi,
): PluginStateKeyedStore<PersistedProgressRun> | undefined {
  const cached = progressStores.get(api);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  if (!api.runtime?.state) {
    progressStores.set(api, null);
    return undefined;
  }
  try {
    const store = api.runtime.state.openKeyedStore<PersistedProgressRun>({
      namespace: "subagent-progress",
      maxEntries: MAX_TRACKED_RUNS,
      overflowPolicy: "reject-new",
      defaultTtlMs: PROGRESS_STORE_TTL_MS,
    });
    progressStores.set(api, store);
    return store;
  } catch (error) {
    logFailure(api, "state store open", error);
    return undefined;
  }
}

async function persistProgressRun(
  api: ProgressApi,
  runId: string,
  tracker: ProgressTracker,
): Promise<PersistProgressResult> {
  const store = getProgressStore(api);
  if (!store) {
    return "error";
  }
  const value = persistedProgressRunFromTracker(tracker, "active");
  try {
    if (await store.registerIfAbsent(runId, value)) {
      return "persisted";
    }
    const existing = await store.lookup(runId);
    if (!existing) {
      return "error";
    }
    if (existing.status === "cleanup") {
      return "terminal";
    }
    return existing.key === value.key ? "persisted" : "conflict";
  } catch (error) {
    logFailure(api, "state store write", error);
    return "error";
  }
}

function persistedProgressRunFromTracker(
  tracker: ProgressTracker,
  status: PersistedProgressRun["status"],
): PersistedProgressRun {
  return {
    key: `${tracker.accountId}:${tracker.channelId}:${tracker.messageId}`,
    accountId: tracker.accountId,
    channelId: tracker.channelId,
    messageId: tracker.messageId,
    status,
    ...(tracker.runningEmoji ? { runningEmoji: tracker.runningEmoji } : {}),
  };
}

async function markProgressRunForCleanup(
  api: ProgressApi,
  runId: string,
  persisted: PersistedProgressRun,
) {
  try {
    await getProgressStore(api)?.register(runId, { ...persisted, status: "cleanup" });
    return true;
  } catch (error) {
    logFailure(api, "state store cleanup mark", error);
    return false;
  }
}

async function lookupProgressRun(
  api: ProgressApi,
  runId: string,
): Promise<ProgressRunLookupResult> {
  const store = getProgressStore(api);
  if (!store) {
    return { status: "error" };
  }
  try {
    const value = await store.lookup(runId);
    return value ? { status: "found", value } : { status: "missing" };
  } catch (error) {
    logFailure(api, "state store read", error);
    return { status: "error" };
  }
}

async function consumeProgressRun(api: ProgressApi, runId: string) {
  try {
    return await getProgressStore(api)?.consume(runId);
  } catch (error) {
    logFailure(api, "state store consume", error);
    return undefined;
  }
}

async function listProgressStateForKey(
  api: ProgressApi,
  key: string,
): Promise<ProgressStateForKeyResult> {
  const store = getProgressStore(api);
  if (!store) {
    return { ok: false };
  }
  try {
    const entries = await store.entries();
    const matching = entries.filter((entry) => entry.value.key === key);
    return {
      ok: true,
      activeRunIds: matching
        .filter((entry) => entry.value.status === "active")
        .map((entry) => entry.key),
      cleanupRunIds: matching
        .filter((entry) => entry.value.status === "cleanup")
        .map((entry) => entry.key),
      ownedEmojis: Array.from(new Set(matching.flatMap((entry) => entry.value.runningEmoji ?? []))),
    };
  } catch (error) {
    logFailure(api, "state store list", error);
    return { ok: false };
  }
}

async function runQueued(key: string, task: () => Promise<void>) {
  const previous = trackerQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  trackerQueues.set(key, current);
  try {
    await current;
  } finally {
    if (trackerQueues.get(key) === current) {
      trackerQueues.delete(key);
    }
  }
}

function logFailure(api: ProgressApi, action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  api.logger.debug?.(`discord subagent progress ${action} failed: ${message}`);
}

async function setReaction(api: ProgressApi, tracker: ProgressTracker, emoji: string) {
  try {
    const result = await reactMessageDiscord(tracker.channelId, tracker.messageId, emoji, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
    return result.ok;
  } catch (error) {
    logFailure(api, "reaction add", error);
    return false;
  }
}

async function clearReaction(api: ProgressApi, tracker: ProgressTracker, emoji?: string) {
  if (!emoji) {
    return true;
  }
  try {
    const result = await removeReactionDiscord(tracker.channelId, tracker.messageId, emoji, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
    return result.ok;
  } catch (error) {
    logFailure(api, "reaction remove", error);
    return false;
  }
}

async function clearRunningReactions(
  api: ProgressApi,
  tracker: ProgressTracker,
  emojis: readonly string[],
) {
  const results = await Promise.all(emojis.map((emoji) => clearReaction(api, tracker, emoji)));
  return results.every(Boolean);
}

async function persistTrackerRunningEmoji(api: ProgressApi, tracker: ProgressTracker) {
  const store = getProgressStore(api);
  if (!store) {
    return false;
  }
  try {
    await Promise.all(
      Array.from(tracker.persistedRunIds, (runId) =>
        store.register(runId, persistedProgressRunFromTracker(tracker, "active")),
      ),
    );
    return true;
  } catch (error) {
    logFailure(api, "reaction ownership write", error);
    return false;
  }
}

async function updateRunningReaction(api: ProgressApi, tracker: ProgressTracker) {
  if (!tracker.reactionsEnabled) {
    return true;
  }
  const nextEmoji =
    tracker.activeRunIds.size > 0
      ? RUNNING_EMOJIS[Math.min(tracker.activeRunIds.size, RUNNING_EMOJIS.length) - 1]
      : undefined;
  if (nextEmoji === tracker.runningEmoji) {
    if (!nextEmoji || tracker.runningEmojiConfirmed) {
      return true;
    }
    if (!(await persistTrackerRunningEmoji(api, tracker))) {
      return false;
    }
    tracker.runningEmojiConfirmed = await setReaction(api, tracker, nextEmoji);
    return tracker.runningEmojiConfirmed;
  }
  if (!(await clearReaction(api, tracker, tracker.runningEmoji))) {
    return false;
  }
  tracker.runningEmoji = undefined;
  tracker.runningEmojiConfirmed = false;
  if (nextEmoji) {
    // Discord may apply the idempotent add before its response is lost. Keep
    // attempted ownership so terminal cleanup still removes the possible glyph.
    tracker.runningEmoji = nextEmoji;
    if (!(await persistTrackerRunningEmoji(api, tracker))) {
      tracker.runningEmoji = undefined;
      return false;
    }
    tracker.runningEmojiConfirmed = await setReaction(api, tracker, nextEmoji);
    return tracker.runningEmojiConfirmed;
  }
  await persistTrackerRunningEmoji(api, tracker);
  return true;
}

async function disableTrackerReactionsOnCollision(
  api: ProgressApi,
  tracker: ProgressTracker,
  ackReaction?: string,
) {
  if (!tracker.reactionsEnabled || reactionsAreAvailable(api.config, ackReaction)) {
    return true;
  }
  const reserved = reservedReactionEmojis(api.config, ackReaction);
  if (tracker.runningEmoji && !reserved.has(tracker.runningEmoji)) {
    if (!(await clearReaction(api, tracker, tracker.runningEmoji))) {
      tracker.reactionsEnabled = false;
      return false;
    }
  }
  tracker.runningEmoji = undefined;
  tracker.runningEmojiConfirmed = false;
  tracker.reactionsEnabled = false;
  await persistTrackerRunningEmoji(api, tracker);
  return true;
}

async function sendTyping(api: ProgressApi, tracker: ProgressTracker) {
  try {
    await sendTypingDiscord(tracker.channelId, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
  } catch (error) {
    logFailure(api, "typing", error);
  }
}

function startTyping(api: ProgressApi, tracker: ProgressTracker) {
  tracker.typingExpiresAt = Date.now() + TYPING_TTL_MS;
  void sendTyping(api, tracker);
  if (tracker.typingTimer) {
    return;
  }
  tracker.typingTimer = setInterval(() => {
    if (tracker.activeRunIds.size === 0 || Date.now() >= tracker.typingExpiresAt) {
      stopTyping(tracker);
      return;
    }
    void sendTyping(api, tracker);
  }, TYPING_INTERVAL_MS);
  tracker.typingTimer.unref?.();
}

function stopTyping(tracker: ProgressTracker) {
  if (tracker.typingTimer) {
    clearInterval(tracker.typingTimer);
    tracker.typingTimer = undefined;
  }
}

async function handleStarted(
  api: ProgressApi,
  event: Extract<SubagentProgressEvent, { phase: "started" }>,
) {
  const runId = event.runId.trim();
  const target = resolveTarget(event);
  if (!runId || !target || isRunTerminal(runId)) {
    return;
  }
  const account = resolveDiscordAccount({ cfg: api.config, accountId: event.requester?.accountId });
  if (!account.enabled || account.config.subagentProgress !== true) {
    return;
  }
  const key = `${account.accountId}:${target.channelId}:${target.messageId}`;
  await runQueued(key, async () => {
    let tracker = trackers.get(key);
    let restoredCurrentRunWasTerminal = false;
    if (!tracker) {
      const reactionsEnabled = reactionsAreAvailable(api.config, account.config.ackReaction);
      const restored = await listProgressStateForKey(api, key);
      if (!restored.ok) {
        return;
      }
      restoredCurrentRunWasTerminal = restored.cleanupRunIds.includes(runId);
      tracker = {
        accountId: account.accountId,
        channelId: target.channelId,
        messageId: target.messageId,
        activeRunIds: new Set(restored.activeRunIds),
        persistedRunIds: new Set(restored.activeRunIds),
        runningEmojiConfirmed: false,
        reactionsEnabled,
        typingExpiresAt: 0,
      };
      // The process can stop between durable registration and either Discord
      // reaction call. Rebuild from bot-owned glyphs instead of guessing which
      // count made it to Discord.
      if (restored.activeRunIds.length > 0 || restored.cleanupRunIds.length > 0) {
        const reserved = reservedReactionEmojis(api.config, account.config.ackReaction);
        const cleanupEmojis = restored.ownedEmojis.filter((emoji) => !reserved.has(emoji));
        if (await clearRunningReactions(api, tracker, cleanupEmojis)) {
          for (const cleanupRunId of restored.cleanupRunIds) {
            markRunTerminal(cleanupRunId);
          }
          await Promise.all(
            restored.cleanupRunIds.map((cleanupRunId) => consumeProgressRun(api, cleanupRunId)),
          );
        } else {
          tracker.reactionsEnabled = false;
        }
      }
      trackers.set(key, tracker);
    }
    if (!(await disableTrackerReactionsOnCollision(api, tracker, account.config.ackReaction))) {
      return;
    }
    if (restoredCurrentRunWasTerminal) {
      if (tracker.activeRunIds.size > 0) {
        await updateRunningReaction(api, tracker);
        startTyping(api, tracker);
      } else {
        trackers.delete(key);
      }
      return;
    }
    if (tracker.activeRunIds.has(runId)) {
      trackerKeyByRunId.set(runId, key);
      await updateRunningReaction(api, tracker);
      startTyping(api, tracker);
      return;
    }
    let persistResult: PersistProgressResult = "error";
    if (tracker.reactionsEnabled) {
      persistResult = await persistProgressRun(api, runId, tracker);
      if (persistResult === "terminal") {
        markRunTerminal(runId);
        return;
      }
      if (persistResult === "conflict") {
        api.logger.debug?.(`discord subagent progress ignored conflicting run id: ${runId}`);
        return;
      }
      if (persistResult === "error") {
        await clearReaction(api, tracker, tracker.runningEmoji);
        tracker.runningEmoji = undefined;
        tracker.runningEmojiConfirmed = false;
        tracker.reactionsEnabled = false;
      }
    }
    tracker.activeRunIds.add(runId);
    trackerKeyByRunId.set(runId, key);
    if (persistResult === "persisted") {
      tracker.persistedRunIds.add(runId);
    }
    // A fast child can end between hook dispatch and durable presentation setup.
    // The tombstone makes that ordering explicit and prevents a late start from sticking.
    if (isRunTerminal(runId)) {
      const owned = persistedProgressRunFromTracker(tracker, "active");
      await markProgressRunForCleanup(api, runId, owned);
      await consumeProgressRun(api, runId);
      tracker.activeRunIds.delete(runId);
      tracker.persistedRunIds.delete(runId);
      trackerKeyByRunId.delete(runId);
      await updateRunningReaction(api, tracker);
      if (tracker.activeRunIds.size === 0) {
        stopTyping(tracker);
        trackers.delete(key);
      }
      return;
    }
    await updateRunningReaction(api, tracker);
    startTyping(api, tracker);
  });
}

async function reconcilePersistedTracker(
  api: ProgressApi,
  persisted: PersistedProgressRun,
  outcome: Extract<SubagentProgressEvent, { phase: "ended" }>["outcome"],
  endingRunId: string,
): Promise<PersistedReconciliationResult> {
  const store = getProgressStore(api);
  let activeRunIds: string[] = [];
  if (store) {
    try {
      const entries = await store.entries();
      activeRunIds = entries
        .filter(
          (entry) =>
            entry.key !== endingRunId &&
            entry.value.key === persisted.key &&
            entry.value.status === "active",
        )
        .map((entry) => entry.key);
    } catch (error) {
      logFailure(api, "state store list", error);
      return { ok: false };
    }
  }
  const tracker: ProgressTracker = {
    accountId: persisted.accountId,
    channelId: persisted.channelId,
    messageId: persisted.messageId,
    activeRunIds: new Set(activeRunIds),
    persistedRunIds: new Set(activeRunIds),
    runningEmojiConfirmed: false,
    reactionsEnabled: true,
    typingExpiresAt: 0,
  };
  const account = resolveDiscordAccount({ cfg: api.config, accountId: persisted.accountId });
  const typingEnabled = account.enabled && account.config.subagentProgress === true;
  const reserved = reservedReactionEmojis(api.config, account.config.ackReaction);
  const cleanupEmojis =
    persisted.runningEmoji && !reserved.has(persisted.runningEmoji) ? [persisted.runningEmoji] : [];
  const reactionsEnabled =
    typingEnabled && reactionsAreAvailable(api.config, account.config.ackReaction);
  // Preserve newly reserved keycaps, but remove every unreserved glyph that
  // this feature could have left behind under the previous configuration.
  const reactionsCleared =
    account.enabled && (await clearRunningReactions(api, tracker, cleanupEmojis));
  const nextEmoji = RUNNING_EMOJIS[Math.min(activeRunIds.length, RUNNING_EMOJIS.length) - 1];
  let countPresented = true;
  if (reactionsEnabled && reactionsCleared && nextEmoji) {
    tracker.runningEmoji = nextEmoji;
    countPresented =
      (await persistTrackerRunningEmoji(api, tracker)) &&
      (await setReaction(api, tracker, nextEmoji));
    tracker.runningEmojiConfirmed = countPresented;
  }
  if (reactionsEnabled && reactionsCleared && countPresented && outcome !== "ok") {
    await setReaction(api, tracker, FAILURE_EMOJI);
  }
  if (!reactionsCleared || !countPresented) {
    return { ok: false };
  }
  return {
    ok: true,
    activeRunIds,
    reactionsEnabled,
    typingEnabled,
    ...(reactionsEnabled && nextEmoji ? { runningEmoji: nextEmoji } : {}),
  };
}

function scheduleTerminalLookupRetry(
  api: ProgressApi,
  event: Extract<SubagentProgressEvent, { phase: "ended" }>,
  owned?: PersistedProgressRun,
) {
  const runId = event.runId.trim();
  if (!runId || terminalRetryTimers.has(runId)) {
    return;
  }
  if (!owned) {
    const target = resolveTarget({ phase: "started", runId, requester: event.requester });
    const account = resolveDiscordAccount({
      cfg: api.config,
      accountId: event.requester?.accountId,
    });
    if (!target || !account.enabled || account.config.subagentProgress !== true) {
      return;
    }
  }
  if (terminalRetryTimers.size >= MAX_TRACKED_RUNS) {
    return;
  }
  const expiresAt = terminalRetryExpiresAt.get(runId) ?? Date.now() + PROGRESS_STORE_TTL_MS;
  const attempts = terminalRetryAttempts.get(runId) ?? 0;
  if (expiresAt <= Date.now() || attempts >= TERMINAL_RETRY_MAX_ATTEMPTS) {
    clearTerminalRetry(runId);
    return;
  }
  terminalRetryExpiresAt.set(runId, expiresAt);
  terminalRetryAttempts.set(runId, attempts + 1);
  const retryDelayMs = Math.min(
    TERMINAL_LOOKUP_RETRY_MS * 2 ** Math.min(attempts, 12),
    TERMINAL_RETRY_MAX_DELAY_MS,
  );
  const timer = setTimeout(() => {
    terminalRetryTimers.delete(runId);
    void handleEnded(api, event, owned);
  }, retryDelayMs);
  timer.unref?.();
  terminalRetryTimers.set(runId, timer);
}

async function handleEnded(
  api: ProgressApi,
  event: Extract<SubagentProgressEvent, { phase: "ended" }>,
  persistedHint?: PersistedProgressRun,
) {
  const runId = event.runId.trim();
  if (!runId) {
    return;
  }
  markRunTerminal(runId);
  const lookup = await lookupProgressRun(api, runId);
  const persisted = lookup.status === "found" ? lookup.value : persistedHint;
  const key = trackerKeyByRunId.get(runId) ?? persisted?.key;
  if (!key) {
    if (lookup.status === "error") {
      scheduleTerminalLookupRetry(api, event);
    } else {
      clearTerminalRetry(runId);
    }
    return;
  }
  cancelTerminalRetryTimer(runId);
  await runQueued(key, async () => {
    const tracker = trackers.get(key);
    trackerKeyByRunId.delete(runId);
    const owned =
      persisted ??
      (lookup.status === "error" && tracker?.persistedRunIds.has(runId)
        ? persistedProgressRunFromTracker(tracker, "active")
        : undefined);
    const cleanupMarked = owned
      ? owned.status === "cleanup" || (await markProgressRunForCleanup(api, runId, owned))
      : true;
    if (tracker) {
      const currentAccount = resolveDiscordAccount({
        cfg: api.config,
        accountId: tracker.accountId,
      });
      if (!currentAccount.enabled || currentAccount.config.subagentProgress !== true) {
        tracker.reactionsEnabled = false;
        stopTyping(tracker);
      } else {
        await disableTrackerReactionsOnCollision(api, tracker, currentAccount.config.ackReaction);
      }
    }
    if (!tracker) {
      const reconciliation = owned
        ? await reconcilePersistedTracker(api, owned, event.outcome, runId)
        : { ok: false as const };
      if (reconciliation.ok && owned) {
        const consumed = await consumeProgressRun(api, runId);
        if (!consumed) {
          scheduleTerminalLookupRetry(api, event, owned);
        } else {
          clearTerminalRetry(runId);
        }
        if (reconciliation.typingEnabled && reconciliation.activeRunIds.length > 0) {
          const restoredTracker: ProgressTracker = {
            accountId: owned.accountId,
            channelId: owned.channelId,
            messageId: owned.messageId,
            activeRunIds: new Set(reconciliation.activeRunIds),
            persistedRunIds: new Set(reconciliation.activeRunIds),
            runningEmojiConfirmed: Boolean(reconciliation.runningEmoji),
            reactionsEnabled: reconciliation.reactionsEnabled,
            ...(reconciliation.runningEmoji ? { runningEmoji: reconciliation.runningEmoji } : {}),
            typingExpiresAt: 0,
          };
          trackers.set(key, restoredTracker);
          for (const activeRunId of reconciliation.activeRunIds) {
            trackerKeyByRunId.set(activeRunId, key);
          }
          startTyping(api, restoredTracker);
        }
      } else if (owned) {
        scheduleTerminalLookupRetry(api, event, owned);
      }
      return;
    }
    tracker.activeRunIds.delete(runId);
    tracker.persistedRunIds.delete(runId);
    const reconciled = tracker.reactionsEnabled
      ? await updateRunningReaction(api, tracker)
      : owned
        ? (await reconcilePersistedTracker(api, owned, event.outcome, runId)).ok
        : true;
    if (reconciled && owned) {
      const consumed = await consumeProgressRun(api, runId);
      if (!consumed) {
        scheduleTerminalLookupRetry(api, event, owned);
      } else {
        clearTerminalRetry(runId);
      }
      if (!consumed && !cleanupMarked) {
        await markProgressRunForCleanup(api, runId, owned);
      }
    } else if (owned) {
      scheduleTerminalLookupRetry(api, event, owned);
    }
    if (reconciled && event.outcome !== "ok" && tracker.reactionsEnabled) {
      await setReaction(api, tracker, FAILURE_EMOJI);
    }
    if (tracker.activeRunIds.size === 0) {
      stopTyping(tracker);
      trackers.delete(key);
    }
  });
}

export async function handleDiscordSubagentProgress(
  api: ProgressApi,
  event: SubagentProgressEvent,
) {
  if (event.phase === "started") {
    await handleStarted(api, event);
    return;
  }
  await handleEnded(api, event);
}

function clearStartupRecoveryRetry(api: ProgressApi) {
  const retry = startupRecoveryRetries.get(api);
  if (retry?.timer) {
    clearTimeout(retry.timer);
  }
  startupRecoveryRetries.delete(api);
}

function scheduleStartupRecoveryRetry(api: ProgressApi) {
  const retry = startupRecoveryRetries.get(api) ?? { attempts: 0 };
  if (retry.timer || retry.attempts >= STARTUP_RETRY_MAX_ATTEMPTS) {
    return;
  }
  const delayMs = Math.min(
    TERMINAL_LOOKUP_RETRY_MS * 2 ** retry.attempts,
    TERMINAL_RETRY_MAX_DELAY_MS,
  );
  retry.attempts += 1;
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    void recoverDiscordSubagentProgress(api);
  }, delayMs);
  retry.timer.unref?.();
  startupRecoveryRetries.set(api, retry);
}

export async function recoverDiscordSubagentProgress(api: ProgressApi) {
  const store = getProgressStore(api);
  if (!store) {
    if (api.runtime?.state) {
      scheduleStartupRecoveryRetry(api);
    }
    return;
  }
  let persistedRuns: Array<{ key: string; value: PersistedProgressRun }>;
  try {
    persistedRuns = await store.entries();
  } catch (error) {
    logFailure(api, "startup recovery list", error);
    scheduleStartupRecoveryRetry(api);
    return;
  }
  clearStartupRecoveryRetry(api);
  // Subagents share the gateway process, so no active run survives a cold
  // start. Replaying every row repairs both interrupted and pending cleanup.
  for (const entry of persistedRuns) {
    await handleEnded(api, { phase: "ended", runId: entry.key, outcome: "ok" }, entry.value);
  }
}

export function resetDiscordSubagentProgressForTest() {
  for (const tracker of trackers.values()) {
    stopTyping(tracker);
  }
  trackers.clear();
  trackerKeyByRunId.clear();
  trackerQueues.clear();
  terminalRunIds.clear();
  for (const timer of terminalRetryTimers.values()) {
    clearTimeout(timer);
  }
  terminalRetryTimers.clear();
  terminalRetryExpiresAt.clear();
  terminalRetryAttempts.clear();
  for (const retry of startupRecoveryRetries.values()) {
    if (retry.timer) {
      clearTimeout(retry.timer);
    }
  }
  startupRecoveryRetries.clear();
  progressStores = new WeakMap();
}
