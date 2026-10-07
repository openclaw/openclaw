import { type WebClient, WebAPIRateLimitedError } from "@slack/web-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { getSlackRuntime } from "../runtime.js";
import { formatSlackTarget } from "../target-parsing.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

export const SLACK_PRESENCE_GREETING_COOLDOWN_MS = 8 * 60 * 60 * 1000;
export const SLACK_PRESENCE_REQUEST_TIMEOUT_MS = 30_000;
const SLACK_PRESENCE_POLL_INTERVAL_MS = 60_000;
const SLACK_PRESENCE_AUTO_MAX_PARTICIPANTS = 8;
const SLACK_PRESENCE_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_PRESENCE_MAX_POLLS_PER_INTERVAL = 45;
const SLACK_PRESENCE_MAX_TARGETS = 2_000;
const DEFAULT_SLACK_PRESENCE_EVENT_PROMPT = [
  "Before greeting, retrieve relevant memory and wiki context for this immutable user_id, including a known timezone when available. Use their local time; if their timezone is unknown, do not guess.",
  "Send at most one short, natural greeting in this Slack conversation. Do not reveal private memory. If no greeting is appropriate, stay silent.",
];

type SlackPresenceEventsConfig = NonNullable<SlackAccountConfig["presenceEvents"]> & {
  prompt?: string;
};
type SlackPresenceEventsMode = NonNullable<SlackPresenceEventsConfig["mode"]>;
type PresenceObservation = { presence: "active" } | { presence: "away"; firstObservedAtMs: number };

type PresenceTarget = {
  key: string;
  isPolicyCurrent: () => boolean;
  teamId?: string;
  mode: Exclude<SlackPresenceEventsMode, "off">;
  prompt: string | undefined;
  channelId: string;
  threadId?: string;
  to: string;
  sessionKey: string;
  agentId: string;
  expectedTarget?: Promise<Awaited<
    ReturnType<PluginRuntime["system"]["captureSessionEventTarget"]>
  > | null>;
  participants: Map<string, number>;
  lastActivityAtMs: number;
  autoEligibleKind: "direct" | "group" | "thread" | "channel";
};

type SlackPresenceClient = Pick<WebClient["users"], "getPresence">;
type PresenceSubject = { teamId?: string; userId: string };

function resolveMode(
  channelConfig: SlackPresenceEventsConfig | undefined,
  accountConfig: SlackPresenceEventsConfig | undefined,
): SlackPresenceEventsMode {
  return channelConfig?.mode ?? accountConfig?.mode ?? "off";
}

export function hasSlackPresenceEventsEnabled(params: {
  account?: SlackPresenceEventsConfig;
  channels?: Record<string, { presenceEvents?: SlackPresenceEventsConfig } | undefined>;
}): boolean {
  if (resolveMode(undefined, params.account) !== "off") {
    return true;
  }
  return Object.values(params.channels ?? {}).some(
    (entry) => resolveMode(entry?.presenceEvents, undefined) !== "off",
  );
}

function isTargetEligible(target: PresenceTarget): boolean {
  if (target.mode === "on") {
    return true;
  }
  if (target.autoEligibleKind === "channel") {
    return false;
  }
  return target.participants.size <= SLACK_PRESENCE_AUTO_MAX_PARTICIPANTS;
}

function formatSlackPresenceEvent(
  target: PresenceTarget,
  userId: string,
  awayObservation: { observedAwayAtMs: number; observedActiveAtMs: number },
): string {
  const { observedAwayAtMs, observedActiveAtMs } = awayObservation;
  const observedAwayDurationMs = Math.max(0, observedActiveAtMs - observedAwayAtMs);
  const promptLines =
    target.prompt === undefined
      ? DEFAULT_SLACK_PRESENCE_EVENT_PROMPT
      : target.prompt.length > 0
        ? [target.prompt]
        : [];
  const lines = [
    "Slack presence event:",
    `A human participant became active on Slack after being observed away: user_id=${JSON.stringify(userId)}${target.teamId ? ` team_id=${JSON.stringify(target.teamId)}` : ""} channel_id=${JSON.stringify(target.channelId)}${target.threadId ? ` thread_ts=${JSON.stringify(target.threadId)}` : ""}.`,
    `observed_away_at_ms=${observedAwayAtMs} observed_active_at_ms=${observedActiveAtMs} observed_away_duration_ms=${observedAwayDurationMs}`,
    ...promptLines,
  ];
  return lines.join("\n");
}

function resolveObservedTarget(params: {
  prepared: PreparedSlackMessage;
  accountConfig?: SlackPresenceEventsConfig;
  nowMs: number;
}): PresenceTarget | null {
  const { prepared } = params;
  const userId = prepared.message.user?.trim();
  if (!userId || prepared.message.bot_id || prepared.message.subtype === "bot_message") {
    return null;
  }
  const mode = resolveMode(prepared.channelConfig?.presenceEvents, params.accountConfig);
  if (mode === "off") {
    return null;
  }
  const channelId = prepared.message.channel;
  const rawThreadId =
    prepared.ctxPayload.MessageThreadId ?? prepared.ctxPayload.TransportThreadId ?? undefined;
  const threadId = rawThreadId === undefined ? undefined : String(rawThreadId);
  const channelType = prepared.message.channel_type;
  const autoEligibleKind = prepared.isDirectMessage
    ? "direct"
    : channelType === "mpim"
      ? "group"
      : threadId
        ? "thread"
        : "channel";
  // Auto excludes top-level channels; excluded activity must not consume the bounded target map.
  if (mode === "auto" && autoEligibleKind === "channel") {
    return null;
  }
  const targetSuffix = threadId ? `:thread:${threadId}` : ":top";
  const teamId = prepared.eventScope?.teamId;
  const targetKind = prepared.isDirectMessage ? "user" : "channel";
  const targetId = prepared.isDirectMessage ? userId : channelId;
  return {
    key: `${teamId ? `team:${teamId}:` : ""}${channelId}${targetSuffix}`,
    ...(teamId ? { teamId } : {}),
    mode,
    prompt: prepared.channelConfig?.presenceEvents?.prompt ?? params.accountConfig?.prompt,
    channelId,
    threadId,
    to: formatSlackTarget({
      teamId,
      kind: targetKind,
      id: targetId,
      explicitKind: true,
    }),
    sessionKey: prepared.route.sessionKey,
    agentId: prepared.route.agentId,
    isPolicyCurrent: prepared.ctx.isRuntimePolicyCurrent,
    participants: new Map([[userId, params.nowMs]]),
    lastActivityAtMs: params.nowMs,
    autoEligibleKind,
  };
}

export function createSlackPresenceMonitor(params: {
  scheduler: PluginServiceSchedulerV1;
  accountId: string;
  accountConfig?: SlackPresenceEventsConfig;
  client?: SlackPresenceClient;
  resolveClient?: (teamId?: string) => SlackPresenceClient;
  cooldownStore: PluginStateKeyedStore<number>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  enqueue?: PluginRuntime["system"]["enqueueSessionEvent"];
  captureTarget?: PluginRuntime["system"]["captureSessionEventTarget"];
}) {
  const resolveClient = params.resolveClient ?? (() => params.client);
  if (!params.client && !params.resolveClient) {
    throw new Error("Slack presence monitor requires a client or client resolver");
  }
  const targets = new Map<string, PresenceTarget>();
  const presenceByUser = new Map<string, PresenceObservation>();
  const nowMs = params.scheduler.now;
  const enqueue = params.enqueue ?? getSlackRuntime().system.enqueueSessionEvent;
  const captureTarget = params.captureTarget ?? getSlackRuntime().system.captureSessionEventTarget;
  let pollOffset = 0;
  const scheduler = params.scheduler.scope();
  let started = false;
  const rateLimitedUntilByWorkspace = new Map<string, number>();

  const pruneTargets = (now: number) => {
    for (const [key, target] of targets) {
      if (
        !target.isPolicyCurrent() ||
        now - target.lastActivityAtMs >= SLACK_PRESENCE_TARGET_TTL_MS
      ) {
        targets.delete(key);
      }
    }
    pruneMapToMaxSize(targets, SLACK_PRESENCE_MAX_TARGETS);
    const eligibleUsers = new Set(
      Array.from(targets.values())
        .filter(isTargetEligible)
        .flatMap((target) =>
          Array.from(target.participants.keys()).map((userId) =>
            presenceSubjectKey({ teamId: target.teamId, userId }),
          ),
        ),
    );
    for (const userId of presenceByUser.keys()) {
      if (!eligibleUsers.has(userId)) {
        presenceByUser.delete(userId);
      }
    }
  };

  const observe = (prepared: PreparedSlackMessage) => {
    const now = nowMs();
    // Expire old eligibility before adding a fresh target so a returning user gets a new baseline.
    pruneTargets(now);
    const observed = resolveObservedTarget({
      prepared,
      accountConfig: params.accountConfig,
      nowMs: now,
    });
    if (scheduler.signal.aborted || !observed || !observed.isPolicyCurrent()) {
      return;
    }
    observed.expectedTarget = captureTarget(observed.agentId, observed.sessionKey).catch(
      (error: unknown) => {
        params.error?.(`slack presence target capture failed: ${String(error)}`);
        return null;
      },
    );
    const current = targets.get(observed.key);
    if (current) {
      current.mode = observed.mode;
      current.prompt = observed.prompt;
      current.sessionKey = observed.sessionKey;
      current.agentId = observed.agentId;
      current.expectedTarget = observed.expectedTarget;
      current.to = observed.to;
      current.lastActivityAtMs = now;
      for (const [participant, observedAt] of observed.participants) {
        current.participants.set(participant, observedAt);
      }
      targets.delete(observed.key);
      targets.set(observed.key, current);
    } else {
      targets.set(observed.key, observed);
    }
    pruneTargets(now);
  };

  const emitTransition = async (
    subject: PresenceSubject,
    awayObservation: { observedAwayAtMs: number; observedActiveAtMs: number },
  ) => {
    const { teamId, userId } = subject;
    const resolveTarget = () =>
      Array.from(targets.values())
        .filter(
          (candidate) =>
            candidate.teamId === teamId &&
            candidate.participants.has(userId) &&
            isTargetEligible(candidate),
        )
        .toSorted(
          (a, b) => (b.participants.get(userId) ?? 0) - (a.participants.get(userId) ?? 0),
        )[0];
    if (!resolveTarget()) {
      return;
    }
    const workspaceKey = teamId ?? "workspace";
    const cooldownKey = `${params.accountId}:${workspaceKey}:${userId}`;
    const now = awayObservation.observedActiveAtMs;
    let reserved: boolean;
    try {
      reserved = await params.cooldownStore.registerIfAbsent(cooldownKey, now, {
        ttlMs: SLACK_PRESENCE_GREETING_COOLDOWN_MS,
      });
    } catch (err) {
      params.error?.(`slack presence cooldown persistence failed: ${String(err)}`);
      return;
    }
    if (!reserved) {
      return;
    }
    pruneTargets(nowMs());
    const target = scheduler.signal.aborted ? undefined : resolveTarget();
    if (!target) {
      await params.cooldownStore.deleteIfEqual?.(cooldownKey, now);
      return;
    }
    const capturedTarget = target.expectedTarget;
    const expectedTarget = await capturedTarget;
    pruneTargets(nowMs());
    if (
      !expectedTarget ||
      scheduler.signal.aborted ||
      resolveTarget() !== target ||
      target.expectedTarget !== capturedTarget
    ) {
      await params.cooldownStore.deleteIfEqual?.(cooldownKey, now);
      return;
    }
    try {
      const receipt = enqueue(formatSlackPresenceEvent(target, userId, awayObservation), {
        expectedTarget,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        contextKey: `slack:presence-active:${params.accountId}:${workspaceKey}:${userId}`,
        deliveryContext: {
          channel: "slack",
          to: target.to,
          accountId: params.accountId,
          threadId: target.threadId,
        },
      });
      void receipt.settled.then((outcome) => {
        if (outcome.status !== "completed") {
          params.error?.(
            `slack presence follow-up ${outcome.status}: ${outcome.error ?? "cancelled"}`,
          );
        }
      });
    } catch (error) {
      await params.cooldownStore.deleteIfEqual?.(cooldownKey, now);
      params.error?.(`slack presence follow-up refused: ${String(error)}`);
    }
  };

  const performPoll = async () => {
    const now = nowMs();
    pruneTargets(now);
    const candidatesByKey = new Map<string, PresenceSubject>();
    for (const target of targets.values()) {
      if (!isTargetEligible(target)) {
        continue;
      }
      for (const userId of target.participants.keys()) {
        const subject = { teamId: target.teamId, userId };
        candidatesByKey.set(presenceSubjectKey(subject), subject);
      }
    }
    const candidates = Array.from(candidatesByKey.entries())
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, subject]) => subject);
    if (candidates.length === 0) {
      return;
    }
    const count = Math.min(candidates.length, SLACK_PRESENCE_MAX_POLLS_PER_INTERVAL);
    const selected = Array.from(
      { length: count },
      (_, index) => candidates[(pollOffset + index) % candidates.length],
    ).filter((subject): subject is PresenceSubject => Boolean(subject));
    for (const subject of selected) {
      if (scheduler.signal.aborted) {
        return;
      }
      const { teamId, userId } = subject;
      const workspaceKey = teamId ?? "workspace";
      const rateLimitedUntilMs = rateLimitedUntilByWorkspace.get(workspaceKey) ?? 0;
      if (rateLimitedUntilMs > now) {
        continue;
      }
      rateLimitedUntilByWorkspace.delete(workspaceKey);
      let consumed = false;
      try {
        const client = resolveClient(teamId);
        if (!client) {
          throw new Error("Slack presence client is unavailable");
        }
        const response = await withTimeout(
          client.getPresence({ user: userId }),
          SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
          {
            message: `Slack presence request timed out after ${SLACK_PRESENCE_REQUEST_TIMEOUT_MS}ms`,
          },
        );
        if (scheduler.signal.aborted) {
          return;
        }
        consumed = true;
        const next =
          response.presence === "active" || response.presence === "away"
            ? response.presence
            : undefined;
        if (!next) {
          continue;
        }
        const subjectKey = presenceSubjectKey(subject);
        const previous = presenceByUser.get(subjectKey);
        const observedAtMs = nowMs();
        const observation: PresenceObservation =
          next === "away"
            ? previous?.presence === "away"
              ? previous
              : { presence: "away", firstObservedAtMs: observedAtMs }
            : { presence: "active" };
        presenceByUser.set(subjectKey, observation);
        if (previous?.presence === "away" && next === "active") {
          await emitTransition(subject, {
            observedAwayAtMs: previous.firstObservedAtMs,
            observedActiveAtMs: observedAtMs,
          });
        }
      } catch (err) {
        if (scheduler.signal.aborted) {
          return;
        }
        if (err instanceof WebAPIRateLimitedError) {
          rateLimitedUntilByWorkspace.set(
            workspaceKey,
            Math.max(rateLimitedUntilMs, nowMs() + Math.max(0, err.retryAfter) * 1_000),
          );
          params.error?.(`slack presence polling rate limited; retrying after ${err.retryAfter}s`);
          continue;
        }
        consumed = true;
        params.error?.(
          `slack presence poll failed for workspace ${workspaceKey} user ${userId}: ${String(err)}`,
        );
      } finally {
        if (consumed) {
          pollOffset = (pollOffset + 1) % candidates.length;
        }
      }
    }
  };

  return {
    observe,
    start: () => {
      if (started || scheduler.signal.aborted) {
        return;
      }
      started = true;
      params.log?.(`slack presence polling enabled for account ${params.accountId}`);
      scheduler.schedule({
        id: "presence",
        delayMs: SLACK_PRESENCE_POLL_INTERVAL_MS,
        everyMs: SLACK_PRESENCE_POLL_INTERVAL_MS,
        run: performPoll,
      });
    },
    stop: () => scheduler.stop(),
  };
}

function presenceSubjectKey(subject: PresenceSubject): string {
  return `${subject.teamId ?? "workspace"}:${subject.userId}`;
}
