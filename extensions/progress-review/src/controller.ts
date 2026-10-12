import { randomUUID } from "node:crypto";
import { buildReviewEvidence, type ReviewEvidence } from "./evidence.js";

export type ProgressReviewSchedule = {
  /** Completed agent turns between reviews; 0 turns this trigger off. */
  everyTurns: number;
  /** Minutes of accumulated agent run time between reviews; 0 turns this trigger off. */
  everyMinutes: number;
};

type ProgressReviewDeps = {
  schedule: ProgressReviewSchedule;
  /** Resolves to the finding, or null when the reviewer found nothing to correct. */
  review: (input: {
    agentId: string;
    evidence: ReviewEvidence;
    previousAdvice?: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
  deliver: (input: {
    agentId: string;
    sessionKey: string;
    finding: string;
    reviewId: string;
  }) => Promise<boolean>;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  /** Starts work outside the finished turn; false when no background owner is running. */
  runInBackground: (sessionKey: string, run: () => Promise<void>) => boolean;
};

type SessionState = {
  turns: number;
  activeMs: number;
  inFlight?: AbortController;
  previousAdvice?: string;
};

const MAX_TRACKED_SESSIONS = 1000;

export function createProgressReviewController(deps: ProgressReviewDeps) {
  const sessions = new Map<string, SessionState>();
  const everyMs = deps.schedule.everyMinutes * 60_000;

  function stateFor(sessionKey: string): SessionState {
    const state = sessions.get(sessionKey) ?? { turns: 0, activeMs: 0 };
    // Reinsert so eviction drops the least recently active session first.
    sessions.delete(sessionKey);
    sessions.set(sessionKey, state);
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      for (const [key, candidate] of sessions) {
        if (!candidate.inFlight) {
          sessions.delete(key);
          break;
        }
      }
    }
    return state;
  }

  function isDue(state: SessionState): boolean {
    return (
      (deps.schedule.everyTurns > 0 && state.turns >= deps.schedule.everyTurns) ||
      (everyMs > 0 && state.activeMs >= everyMs)
    );
  }

  function resetInterval(state: SessionState) {
    state.turns = 0;
    state.activeMs = 0;
  }

  async function runReview(params: {
    sessionKey: string;
    agentId: string;
    state: SessionState;
    evidence: ReviewEvidence;
    controller: AbortController;
  }): Promise<void> {
    const { sessionKey, agentId, state, controller } = params;
    try {
      const finding = await deps.review({
        agentId,
        evidence: params.evidence,
        previousAdvice: state.previousAdvice,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      resetInterval(state);
      if (!finding) {
        deps.logger.info(`progress-review: no correction for session ${sessionKey}`);
        return;
      }
      state.previousAdvice = finding;
      const queued = await deps.deliver({ agentId, sessionKey, finding, reviewId: randomUUID() });
      deps.logger.info(
        queued
          ? `progress-review: queued a correction for the next turn of session ${sessionKey}`
          : `progress-review: the host did not queue the correction for session ${sessionKey}`,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      // A failed review waits a full interval: persistent provider errors must not cost a call per turn.
      resetInterval(state);
      deps.logger.warn(
        `progress-review: review failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (state.inFlight === controller) {
        state.inFlight = undefined;
      }
    }
  }

  return {
    /** Records one finished turn and starts a background review when a trigger is due. */
    turnEnded(params: {
      sessionKey: string;
      agentId: string;
      durationMs?: number;
      messages: readonly unknown[];
    }): void {
      const state = stateFor(params.sessionKey);
      state.turns += 1;
      state.activeMs += Math.max(0, params.durationMs ?? 0);
      if (!isDue(state) || state.inFlight) {
        return;
      }
      const evidence = buildReviewEvidence(params.messages);
      if (evidence.requests.length === 0) {
        return;
      }
      const controller = new AbortController();
      state.inFlight = controller;
      const started = deps.runInBackground(params.sessionKey, () =>
        runReview({
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          state,
          evidence,
          controller,
        }),
      );
      if (!started) {
        state.inFlight = undefined;
      }
    },
    /** Drops one session's state, or all state, and cancels the matching reviews. */
    forget(sessionKey?: string) {
      for (const [key, state] of sessions) {
        if (sessionKey === undefined || key === sessionKey) {
          state.inFlight?.abort();
          sessions.delete(key);
        }
      }
    },
  };
}
