import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { runInDetachedAsyncContext } from "openclaw/plugin-sdk/concurrency-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import {
  isExpectedRunCancellation,
  isInternalSessionEffectsKey,
  resolveFailoverReasonFromError,
} from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import type { ReviewedSkillUse } from "./experience-review-prompt.js";
import { workshopLog } from "./runtime.js";

/** Model iterations a session accumulates across turns before a review is due. */
const EXPERIENCE_REVIEW_ITERATION_THRESHOLD = 10;
const EXPERIENCE_REVIEW_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RETRY_IDLE_MS = 30_000;
const EXPERIENCE_REVIEW_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const EXPERIENCE_REVIEW_MAX_BACKOFF_MS = 60 * 60_000;
const EXPERIENCE_REVIEW_MAX_PENDING = 32;
const EXPERIENCE_REVIEW_MAX_COUNTERS = 1024;
const EXPERIENCE_REVIEW_MAX_SUPPRESSED_RUNS = 1024;
const EXPERIENCE_REVIEW_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS = new Set(["acp", "cron", "hook", "subagent"]);

/** The `agent_end` event fields a review reads. */
type ExperienceReviewAgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  modelIterations?: number;
  skillsUsed?: readonly ReviewedSkillUse[];
};

/** The finished turn's final transcript entry: `ctx.completedTurn` plus its session. */
type ExperienceReviewSource = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  entryId: string;
};

type ExperienceReviewAgentContext = {
  runId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  toolNames?: readonly string[];
  trigger?: string;
  agentId: string;
};

export type SkillExperienceReviewParams = {
  event: ExperienceReviewAgentEndEvent;
  ctx: ExperienceReviewAgentContext;
  config: OpenClawConfig;
  source?: ExperienceReviewSource;
  /** The foreground turn itself changed a Workshop skill, so its learning is already saved. */
  workshopMutated?: boolean;
};

export type ExperienceReviewCandidate = {
  ctx: Pick<ExperienceReviewAgentContext, "runId">;
  config: OpenClawConfig;
  /** The fork owner reads the anchored turn's requester, model and workspace at admission. */
  source: ExperienceReviewSource;
  usedSkills?: ExperienceReviewAgentEndEvent["skillsUsed"];
  turnAborted?: boolean;
};

/** Starts one delayed callback; the returned function cancels it. */
type ExperienceReviewTimer = (delayMs: number, run: () => Promise<void> | undefined) => () => void;

type ExperienceReviewSchedulerDeps = {
  isSystemActive: () => boolean | Promise<boolean>;
  runReview: (candidate: ExperienceReviewCandidate, signal: AbortSignal) => Promise<void>;
  /** Owner of the delayed review work; defaults to an unref'd detached timer. */
  setTimer?: ExperienceReviewTimer;
};

type PendingExperienceReview = {
  candidate: ExperienceReviewCandidate;
  cancelTimer?: () => void;
};

// This timer outlives the foreground turn that armed it. Create its async resource outside the
// parent scope so review work admits on the current generation.
const detachedTimer: ExperienceReviewTimer = (delayMs, run) => {
  const timer = runInDetachedAsyncContext(() => setTimeout(() => void run(), delayMs));
  timer.unref?.();
  return () => clearTimeout(timer);
};

function isEligibleContext(ctx: ExperienceReviewAgentContext): boolean {
  // Only harnesses that report both the resolved model and the turn's tool names may
  // schedule. Other runtimes fail closed here.
  if (
    !ctx.toolNames?.includes("skill_workshop") ||
    !ctx.modelProviderId?.trim() ||
    !ctx.modelId?.trim()
  ) {
    return false;
  }
  const trigger = ctx.trigger?.trim().toLowerCase();
  if (trigger && EXPERIENCE_REVIEW_BLOCKED_TRIGGERS.has(trigger)) {
    return false;
  }
  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  // Background Workshop runs use internal session-effects keys and must never review themselves.
  if (
    !sessionKey ||
    sessionKey.includes("active-memory") ||
    isInternalSessionEffectsKey(sessionKey)
  ) {
    return false;
  }
  return !sessionKey
    .split(":")
    .some((segment) => EXPERIENCE_REVIEW_BLOCKED_SESSION_SEGMENTS.has(segment));
}

/**
 * Provider-reported iterations win; otherwise count assistant messages after the last user
 * message. A zero report is no report: Codex counts only raw response events, which resumed
 * threads do not emit.
 */
function resolveTurnModelIterations(params: SkillExperienceReviewParams): number {
  const reported = params.event.modelIterations;
  if (reported !== undefined && Number.isSafeInteger(reported) && reported > 0) {
    return reported;
  }
  const { messages } = params.event;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") {
      break;
    }
    if (isRecord(message) && message.role === "assistant") {
      count += 1;
    }
  }
  return count;
}

/**
 * Counts model iterations per (agent, session) across turns and queues one background review
 * after 10 iterations since its last queued review or its last own Workshop edit.
 * Reviews wait for a quiet period and run one at a time.
 */
export function createSkillExperienceReviewScheduler(deps: ExperienceReviewSchedulerDeps) {
  const iterationsBySession = new Map<string, number>();
  const pendingBySession = new Map<string, PendingExperienceReview>();
  // Explicit stop happens before the stopped turn aborts, and its own agent_end
  // still arrives as an aborted completion. Suppress that exact run once instead
  // of keeping a session-level block that would starve later turns.
  const stoppedRunIds = new Map<string, true>();
  let reviewInFlight = false;
  let inFlightKey: string | undefined;
  let inFlightController: AbortController | undefined;
  let cooldownUntil = 0;
  let rateLimitBackoffMs = 0;
  const deferForRateLimit = () => {
    // One saturated organization can affect every agent/model. Do not let the
    // next queued session replace the failed review with another paid attempt.
    const now = Date.now();
    if (now < cooldownUntil) {
      cooldownUntil = now + rateLimitBackoffMs;
      return;
    }
    rateLimitBackoffMs = Math.min(
      EXPERIENCE_REVIEW_MAX_BACKOFF_MS,
      rateLimitBackoffMs * 2 || EXPERIENCE_REVIEW_RATE_LIMIT_BACKOFF_MS,
    );
    cooldownUntil = now + rateLimitBackoffMs;
  };

  const arm = (key: string, pending: PendingExperienceReview, delayMs: number) => {
    pending.cancelTimer?.();
    // Returns the review's settlement so the timer's owner keeps the work until it ends.
    const timerCallback = (): Promise<void> | undefined => {
      if (pendingBySession.get(key) !== pending) {
        return undefined;
      }
      pending.cancelTimer = undefined;
      // The catch below classifies the settled error after this callback's own
      // finally has run, so retain the controller's abort state here.
      let reviewSignal: AbortSignal | undefined;
      return (async () => {
        const active = await deps.isSystemActive();
        if (pendingBySession.get(key) !== pending) {
          return;
        }
        const cooldownRemaining = cooldownUntil - Date.now();
        if (active || reviewInFlight || cooldownRemaining > 0) {
          arm(key, pending, Math.max(EXPERIENCE_REVIEW_RETRY_IDLE_MS, cooldownRemaining));
          return;
        }
        reviewInFlight = true;
        const controller = new AbortController();
        reviewSignal = controller.signal;
        inFlightKey = key;
        inFlightController = controller;
        try {
          pendingBySession.delete(key);
          await deps.runReview(pending.candidate, controller.signal);
          rateLimitBackoffMs = 0;
        } catch (error) {
          if (resolveFailoverReasonFromError(error) === "rate_limit") {
            deferForRateLimit();
          }
          throw error;
        } finally {
          reviewInFlight = false;
          if (inFlightController === controller) {
            inFlightKey = undefined;
            inFlightController = undefined;
          }
        }
      })().catch((error: unknown) => {
        const expectedCancellation =
          isExpectedRunCancellation(error) ||
          (error instanceof Error && error.name === "AbortError");
        // An aborted review can still fail its independent cleanup. Keep the existing
        // classifier protection: that aggregate is a real failure, never a cancellation.
        const cleanupFailure = error instanceof AggregateError && !expectedCancellation;
        if (!cleanupFailure && (reviewSignal?.aborted || expectedCancellation)) {
          workshopLog().debug(`skill experience review cancelled: ${formatErrorMessage(error)}`);
        } else {
          workshopLog().warn(`skill experience review failed: ${formatErrorMessage(error)}`);
        }
        if (pendingBySession.get(key) === pending) {
          pendingBySession.delete(key);
        }
      });
    };
    pending.cancelTimer = (deps.setTimer ?? detachedTimer)(delayMs, timerCallback);
  };

  const cancel = (key: string) => {
    const pending = pendingBySession.get(key);
    pending?.cancelTimer?.();
    pendingBySession.delete(key);
    iterationsBySession.delete(key);
  };

  /**
   * Suppresses one explicit stop's run ids until their own aborted agent_end arrives.
   * Entries are consumed by that completion, so a later turn for the same session
   * schedules normally; the bounded map only guards against a completion that never comes.
   */
  const suppressRuns = (runIds: Iterable<string>): void => {
    for (const runId of runIds) {
      const normalized = runId.trim();
      if (normalized) {
        stoppedRunIds.set(normalized, true);
      }
    }
    pruneMapToMaxSize(stoppedRunIds, EXPERIENCE_REVIEW_MAX_SUPPRESSED_RUNS);
  };

  const consumeSuppressedRun = (runId: string | undefined): boolean => {
    const normalized = runId?.trim();
    if (!normalized || !stoppedRunIds.delete(normalized)) {
      return false;
    }
    return true;
  };

  /**
   * Drops one session's queued review and aborts its in-flight review after an
   * explicit stop. Counters reset so a later turn can schedule fresh learning.
   */
  const cancelSession = (params: { agentId: string; sessionKey: string }): void => {
    const key = JSON.stringify([params.agentId, params.sessionKey]);
    cancel(key);
    if (inFlightKey === key) {
      inFlightController?.abort(
        new DOMException("Skill experience review stopped by the user", "AbortError"),
      );
    }
  };

  return {
    schedule(params: SkillExperienceReviewParams): void {
      const sessionKey = params.ctx.sessionKey?.trim();
      if (
        !sessionKey ||
        isIncognitoSessionKey(sessionKey) ||
        isIncognitoSessionKey(params.source?.sessionKey)
      ) {
        return;
      }
      // Unqualified keys such as global still belong to one foreground agent.
      const key = JSON.stringify([params.ctx.agentId, sessionKey]);
      // Stop suppression precedes the aborted turn's own agent_end. Drop anything
      // this session queued, but never arm the stopped run or a later session flag.
      if (consumeSuppressedRun(params.ctx.runId)) {
        cancel(key);
        workshopLog().debug(`experience review skipped: reason=stopped-run session=${sessionKey}`);
        return;
      }
      const existing = pendingBySession.get(key);
      // Quiet time follows all later foreground work in the session.
      if (existing) {
        arm(key, existing, EXPERIENCE_REVIEW_IDLE_MS);
      }
      // Errored completions (provider/prompt failures) are environment noise, not
      // learnable evidence. User aborts carry no error and stay eligible.
      if (typeof params.event.error === "string" && params.event.error.trim() !== "") {
        if (resolveFailoverReasonFromError(new Error(params.event.error)) === "rate_limit") {
          deferForRateLimit();
        }
        workshopLog().debug(
          `experience review skipped: reason=errored-completion session=${sessionKey}`,
        );
        return;
      }
      if (resolveSkillWorkshopConfig(params.config).autonomous.mode === "off") {
        cancel(key);
        return;
      }
      if (!isEligibleContext(params.ctx)) {
        workshopLog().debug(
          `experience review skipped: reason=ineligible-context session=${sessionKey}`,
        );
        return;
      }
      // The foreground turn already saved its learning; an older queued review is stale.
      if (params.workshopMutated) {
        cancel(key);
        return;
      }
      const iterations = (iterationsBySession.get(key) ?? 0) + resolveTurnModelIterations(params);
      iterationsBySession.delete(key);
      if (iterations < EXPERIENCE_REVIEW_ITERATION_THRESHOLD) {
        // Re-insert so the least recently active session is the one pruned.
        iterationsBySession.set(key, iterations);
        pruneMapToMaxSize(iterationsBySession, EXPERIENCE_REVIEW_MAX_COUNTERS);
        return;
      }
      const workspaceDir = params.ctx.workspaceDir?.trim();
      const modelProviderId = params.ctx.modelProviderId?.trim();
      const modelId = params.ctx.modelId?.trim();
      const { source } = params;
      if (!workspaceDir || !source || !modelProviderId || !modelId) {
        workshopLog().debug(
          `experience review skipped: reason=missing-context session=${sessionKey}`,
        );
        return;
      }
      if (!existing && pendingBySession.size >= EXPERIENCE_REVIEW_MAX_PENDING) {
        const oldest = pendingBySession.entries().next().value;
        if (oldest) {
          oldest[1].cancelTimer?.();
          pendingBySession.delete(oldest[0]);
        }
      }
      const candidate: ExperienceReviewCandidate = {
        ctx: { runId: params.ctx.runId },
        config: params.config,
        source: { ...source },
        usedSkills: params.event.skillsUsed ? [...params.event.skillsUsed] : undefined,
        turnAborted: !params.event.success,
      };
      const pending = existing ?? { candidate };
      pending.candidate = candidate;
      pendingBySession.set(key, pending);
      arm(key, pending, EXPERIENCE_REVIEW_IDLE_MS);
    },
    cancelSession,
    suppressRuns,
  };
}
