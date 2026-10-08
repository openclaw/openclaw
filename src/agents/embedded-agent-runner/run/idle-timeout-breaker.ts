// Survives profile/auth retries so a stalled provider cannot fan out paid calls
// across every fallback profile (#76293). Partial billed tokens are not progress.
export const MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT = 5;

export type IdleTimeoutBreakerState = {
  consecutiveIdleTimeoutsBeforeOutput: number;
};

// Non-timeout failures without completed progress neither reset nor increment
// the counter: they prove neither recovery nor another idle timeout.
export function stepIdleTimeoutBreaker(
  state: IdleTimeoutBreakerState,
  input: { idleTimedOut: boolean; completedModelProgress: boolean },
) {
  if (input.idleTimedOut && !input.completedModelProgress) {
    state.consecutiveIdleTimeoutsBeforeOutput += 1;
  } else if (input.completedModelProgress) {
    state.consecutiveIdleTimeoutsBeforeOutput = 0;
  }

  return {
    consecutive: state.consecutiveIdleTimeoutsBeforeOutput,
    tripped:
      state.consecutiveIdleTimeoutsBeforeOutput >= MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
  };
}
