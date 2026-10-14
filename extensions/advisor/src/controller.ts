import { randomUUID } from "node:crypto";
import { AdvisorOutputError } from "./review.js";

export type AdvisorSchedule = {
  /** Tool calls started between reviews, including ones still running; 0 turns this trigger off. */
  everyToolCalls: number;
  /** Minutes of accumulated agent run time between reviews; 0 turns this trigger off. */
  everyMinutes: number;
};

type AdvisorDeps = {
  schedule: AdvisorSchedule;
  review: (input: { sessionKey: string; signal: AbortSignal }) => Promise<string | null>;
  deliver: (input: {
    agentId: string;
    sessionKey: string;
    finding: string;
    reviewId: string;
    signal: AbortSignal;
  }) => Promise<void>;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  /** Runs reviews under the plugin service's lifetime, not the triggering hook's. */
  runInBackground: (sessionKey: string, run: () => Promise<void>) => boolean;
};

type SessionState = {
  toolCalls: number;
  activeMs: number;
  run?: { id: string; agentId: string; startedAt: number; accountedMs: number };
  inFlight?: AbortController;
};

const MAX_TRACKED_SESSIONS = 1000;

export function createAdvisorController(deps: AdvisorDeps) {
  const sessions = new Map<string, SessionState>();
  const everyMs = deps.schedule.everyMinutes * 60_000;

  function stateFor(sessionKey: string): SessionState {
    const state = sessions.get(sessionKey) ?? { toolCalls: 0, activeMs: 0 };
    sessions.delete(sessionKey);
    sessions.set(sessionKey, state);
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      for (const [key, candidate] of sessions) {
        if (!candidate.inFlight && !candidate.run) {
          sessions.delete(key);
          break;
        }
      }
    }
    return state;
  }

  function accountTime(state: SessionState, elapsedMs: number) {
    if (!state.run) {
      state.activeMs += Math.max(0, elapsedMs);
      return;
    }
    const elapsed = Math.max(state.run.accountedMs, elapsedMs);
    state.activeMs += elapsed - state.run.accountedMs;
    state.run.accountedMs = elapsed;
  }

  function resetInterval(state: SessionState) {
    if (state.run) {
      accountTime(state, Date.now() - state.run.startedAt);
    }
    state.toolCalls = 0;
    state.activeMs = 0;
  }

  async function runReview(
    sessionKey: string,
    agentId: string,
    state: SessionState,
    controller: AbortController,
  ): Promise<void> {
    try {
      const finding = await deps.review({ sessionKey, signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      resetInterval(state);
      if (!finding) {
        deps.logger.info(`advisor: no correction for session ${sessionKey}`);
        return;
      }
      await deps.deliver({
        agentId,
        sessionKey,
        finding,
        reviewId: randomUUID(),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      // Provider failures wait a full interval instead of retrying after every tool call.
      resetInterval(state);
      const reason =
        error instanceof AdvisorOutputError
          ? error.message
          : error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "fork_failed";
      deps.logger.warn(`advisor: review failed for session ${sessionKey}: ${reason}`);
    } finally {
      if (state.inFlight === controller) {
        state.inFlight = undefined;
      }
    }
  }

  function reviewIfDue(sessionKey: string, agentId: string, state: SessionState) {
    const due =
      (deps.schedule.everyToolCalls > 0 && state.toolCalls >= deps.schedule.everyToolCalls) ||
      (everyMs > 0 && state.activeMs >= everyMs);
    if (!due || state.inFlight) {
      return;
    }
    const controller = new AbortController();
    state.inFlight = controller;
    if (
      !deps.runInBackground(sessionKey, () => runReview(sessionKey, agentId, state, controller))
    ) {
      state.inFlight = undefined;
    }
  }

  return {
    runStarted(params: {
      sessionKey: string;
      agentId: string;
      runId: string;
      startedAt: number;
    }): void {
      const state = stateFor(params.sessionKey);
      if (state.run?.id !== params.runId) {
        state.run = {
          id: params.runId,
          agentId: params.agentId,
          startedAt: params.startedAt,
          accountedMs: 0,
        };
      }
    },
    toolStarted(params: { sessionKey: string; runId: string }): void {
      const state = sessions.get(params.sessionKey);
      // Tool events carry no trigger; only admitted runs with a lifecycle start count.
      if (state?.run?.id !== params.runId) {
        return;
      }
      state.toolCalls += 1;
      accountTime(state, Date.now() - state.run.startedAt);
      reviewIfDue(params.sessionKey, state.run.agentId, state);
    },
    turnEnded(params: {
      sessionKey: string;
      agentId: string;
      runId?: string;
      durationMs?: number;
    }): void {
      const state = stateFor(params.sessionKey);
      if (state.run && params.runId && state.run.id !== params.runId) {
        return;
      }
      accountTime(state, params.durationMs ?? (state.run ? Date.now() - state.run.startedAt : 0));
      state.run = undefined;
      reviewIfDue(params.sessionKey, params.agentId, state);
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
