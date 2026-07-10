/**
 * Production wiring for the {@link GoalContinuationDriver}.
 *
 * This factory binds the pure debounced scheduler (driver.ts) to the real
 * gateway primitives — the durable session-goal store, the active-run registry,
 * the inbound queue, the system-event queue, and the heartbeat-wake path — so an
 * `active` session goal is pursued unattended whenever the session is idle.
 *
 * SHIPS BEHIND `tools.experimental.goalDriver.enabled`: {@link createGoalDriverService}
 * returns `undefined` when the flag is off, so the gateway wires nothing and the
 * lifecycle hooks null-check to a zero-cost no-op. The driver NEVER bypasses an
 * approval gate — it only enqueues a steering prompt + wakes a turn; every tool
 * inside that turn still passes the normal exec/approval path.
 */
import { resolveSessionGoalDisplayState } from "../../config/sessions/goals.js";
import {
  clearSessionGoalWaitBarrier,
  recordSessionGoalContinuation,
  resetSessionGoalContinuations,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionEntry, listSessionEntries } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatAbortControllerEntry } from "../../gateway/chat-abort.js";
import type { QueuedChatTurnMap } from "../../gateway/chat-queued-turns.js";
import { listQueuedChatTurnsForSession } from "../../gateway/chat-queued-turns.js";
import { hasVisibleActiveSessionRun } from "../../gateway/server-methods/session-active-runs.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEventEntry, hasSystemEvents } from "../../infra/system-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { formatGoalDriverContinuationPrompt } from "./continuation-prompt.js";
import {
  createGoalContinuationDriver,
  type GoalContinuationDriver,
  type GoalDriverEvent,
  type GoalDriverGoalSnapshot,
  type GoalDriverLogger,
} from "./driver.js";

export type GoalDriverServiceDeps = {
  config: OpenClawConfig;
  /** Gateway active-run registry (g2). */
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  /** Gateway inbound queued-turn registry (g3). */
  chatQueuedTurns: QueuedChatTurnMap;
  log?: GoalDriverLogger;
  /** Emitted for every internal driver event (test/introspection). */
  onEvent?: (evt: GoalDriverEvent) => void;
  /** Deterministic RNG override for tests. */
  random?: () => number;
};

export type GoalDriverService = GoalContinuationDriver & {
  /** Re-arm every persisted `active` goal (idempotent gateway-startup recovery). */
  rearmPersistedActiveGoals: () => void;
};

/** Resolved, validated goalDriver config. */
type GoalDriverConfig = {
  enabled: boolean;
  debounceMs: number;
  jitterMs: number;
  maxNoProgressContinuations: number;
};

const DEFAULT_DEBOUNCE_MS = 20_000;
const DEFAULT_JITTER_MS = 5_000;
const DEFAULT_MAX_NO_PROGRESS = 3;

export function resolveGoalDriverConfig(config: OpenClawConfig): GoalDriverConfig {
  const raw = config.tools?.experimental?.goalDriver;
  const debounceMs =
    typeof raw?.debounceMs === "number" && raw.debounceMs > 0
      ? raw.debounceMs
      : DEFAULT_DEBOUNCE_MS;
  const jitterMs =
    typeof raw?.jitterMs === "number" && raw.jitterMs >= 0 ? raw.jitterMs : DEFAULT_JITTER_MS;
  const maxNoProgressContinuations =
    typeof raw?.maxNoProgressContinuations === "number" && raw.maxNoProgressContinuations > 0
      ? Math.floor(raw.maxNoProgressContinuations)
      : DEFAULT_MAX_NO_PROGRESS;
  return {
    enabled: raw?.enabled === true,
    debounceMs,
    jitterMs,
    maxNoProgressContinuations,
  };
}

/** Resolves the per-agent session store path for a session key. */
function resolveScope(config: OpenClawConfig, sessionKey: string): { storePath: string } {
  const agentId = normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId);
  return { storePath: resolveStorePath(config.session?.store, { agentId }) };
}

/** Projects the durable goal into the snapshot the driver's gates read. */
function readGoalSnapshot(
  config: OpenClawConfig,
  sessionKey: string,
): GoalDriverGoalSnapshot | undefined {
  const { storePath } = resolveScope(config, sessionKey);
  const entry = loadSessionEntry({ sessionKey, storePath });
  if (!entry) {
    return undefined;
  }
  // persist:false projection — budget exhaustion flips the projected status to
  // budget_limited so the driver disarms without firing (spike test d).
  const goal = resolveSessionGoalDisplayState(entry, undefined, { adoptFreshBaseline: false });
  if (!goal) {
    return undefined;
  }
  return {
    status: goal.status,
    objective: goal.objective,
    tokensUsed: goal.tokensUsed,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    continuationTurns: goal.continuationTurns,
    ...(goal.contract ? { contract: goal.contract } : {}),
    ...(goal.wait?.waitingUntil !== undefined ? { waitingUntil: goal.wait.waitingUntil } : {}),
    ...(goal.wait?.waitingOnSessionKey
      ? { waitingOnSessionKey: goal.wait.waitingOnSessionKey }
      : {}),
  };
}

/**
 * Builds the goal continuation driver bound to the live gateway, or `undefined`
 * when `tools.experimental.goalDriver.enabled` is not set.
 */
export function createGoalDriverService(
  deps: GoalDriverServiceDeps,
): GoalDriverService | undefined {
  const cfg = resolveGoalDriverConfig(deps.config);
  if (!cfg.enabled) {
    return undefined;
  }
  const { config, chatAbortControllers, chatQueuedTurns, log } = deps;

  const driver = createGoalContinuationDriver({
    log,
    debounceMs: cfg.debounceMs,
    jitterMs: cfg.jitterMs,
    maxConsecutiveContinuations: cfg.maxNoProgressContinuations,
    ...(deps.random ? { random: deps.random } : {}),

    readGoal: (sessionKey) => readGoalSnapshot(config, sessionKey),

    // g2 — a Control-UI-visible run owns the session.
    hasActiveRun: (sessionKey) =>
      hasVisibleActiveSessionRun({
        context: { chatAbortControllers },
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
      }),

    // g3 — a queued inbound chat turn or a pending system event exists.
    isInboundQueueEmpty: (sessionKey) =>
      listQueuedChatTurnsForSession({ chatQueuedTurns, sessionKeys: [sessionKey] }).length === 0 &&
      !hasSystemEvents(sessionKey),

    // g5 (session barrier) — the watched session still has a Control-UI-visible
    // run in flight. Reuses the same active-run check as g2, applied to the
    // barrier's target session key rather than the goal's own session.
    isWaitedSessionActive: (waitedSessionKey) =>
      hasVisibleActiveSessionRun({
        context: { chatAbortControllers },
        requestedKey: waitedSessionKey,
        canonicalKey: waitedSessionKey,
      }),
    // g5 — drop a satisfied barrier so the next wake resumes normal gating.
    clearWaitBarrier: (sessionKey) => {
      const { storePath } = resolveScope(config, sessionKey);
      void clearSessionGoalWaitBarrier({ sessionKey, storePath }).catch((err: unknown) => {
        log?.warn({ err: String(err), sessionKey }, "goal-driver: clearWaitBarrier failed");
      });
    },

    buildContinuationPrompt: (goal) => formatGoalDriverContinuationPrompt(goal),

    // FIRE — enqueue the steering prompt AND wake a turn together. The spike
    // proved enqueue-alone strands the event: the queue only drains via the
    // heartbeat-runner, so an immediate targeted heartbeat is mandatory.
    fireContinuation: (sessionKey, prompt) => {
      const agentId = parseAgentSessionKey(sessionKey)?.agentId;
      const enqueued = enqueueSystemEventEntry(prompt, { sessionKey });
      if (!enqueued) {
        // A duplicate/empty event was suppressed; do not wake a no-op turn.
        return;
      }
      requestHeartbeat({
        source: "manual",
        intent: "immediate",
        reason: "goal-continuation",
        sessionKey,
        ...(agentId ? { agentId } : {}),
      });
    },

    recordContinuation: (sessionKey) => {
      const { storePath } = resolveScope(config, sessionKey);
      void recordSessionGoalContinuation({ sessionKey, storePath }).catch((err: unknown) => {
        log?.warn({ err: String(err), sessionKey }, "goal-driver: recordContinuation failed");
      });
    },
    resetContinuations: (sessionKey) => {
      const { storePath } = resolveScope(config, sessionKey);
      void resetSessionGoalContinuations({ sessionKey, storePath }).catch((err: unknown) => {
        log?.warn({ err: String(err), sessionKey }, "goal-driver: resetContinuations failed");
      });
    },
    pauseGoal: (sessionKey, note) => {
      const { storePath } = resolveScope(config, sessionKey);
      // updateSessionGoalStatus emits the `goal.updated` change through the
      // global goal-events emitter, so no separate broadcast is needed here.
      void updateSessionGoalStatus({ sessionKey, storePath, status: "paused", note }).catch(
        (err: unknown) => {
          log?.warn({ err: String(err), sessionKey }, "goal-driver: pauseGoal failed");
        },
      );
    },

    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
  });

  const rearmPersistedActiveGoals = () => {
    // Iterate the default store scope for sessions carrying an active goal. A
    // multi-agent deployment with per-agent stores rearms its default store here;
    // per-agent arming still happens lazily on each agent's next turn-completed.
    const storePath = resolveStorePath(config.session?.store);
    let sessionKeys: string[];
    try {
      sessionKeys = listSessionEntries({ storePath })
        .filter((summary) => summary.entry.goal?.status === "active")
        .map((summary) => summary.sessionKey);
    } catch (err) {
      log?.warn({ err: String(err) }, "goal-driver: rearmPersistedActiveGoals scan failed");
      return;
    }
    driver.rearmActiveGoals(sessionKeys);
  };

  return {
    ...driver,
    rearmPersistedActiveGoals,
  };
}
