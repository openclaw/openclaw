/**
 * Cap on consecutive idle-timeout attempts without completed model progress
 * before the outer run loop refuses another attempt.
 *
 * Distinct from same-model idle retry and broad run-loop backstops: this fires
 * across profile/auth retries so one wedged provider cannot fan out paid calls
 * across every fallback profile in sequence (#76293).
 */
export const MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT = 5;

/** Mutable outer-loop state for the consecutive idle-timeout breaker. */
export type IdleTimeoutBreakerState = {
  consecutiveIdleTimeoutsBeforeOutput: number;
};

/** Creates breaker state that survives across embedded-attempt retries. */
export function createIdleTimeoutBreakerState(): IdleTimeoutBreakerState {
  return { consecutiveIdleTimeoutsBeforeOutput: 0 };
}

/** Latest attempt outcome used to advance the idle-timeout breaker. */
export type IdleTimeoutBreakerInput = {
  idleTimedOut: boolean;
  completedModelProgress: boolean;
  outputTokens?: number;
};

/** Breaker step result returned to the outer run loop. */
export type IdleTimeoutBreakerStep = {
  consecutive: number;
  tripped: boolean;
};

/**
 * Update the breaker counter from the latest attempt's outcome and report
 * whether the cap is now tripped. Designed to be called from the outer run
 * loop right after an embedded attempt completes.
 *
 * Pure function modulo the mutable `state.consecutiveIdleTimeoutsBeforeOutput`
 * field, so the caller decides where the state lives (typically a `let` in
 * the outer loop).
 *
 * Decision table:
 *   idleTimedOut  completedModelProgress   action
 *   ------------  ----------------------   ------
 *   true          false                    count += 1   (wedged provider candidate)
 *   true          true                     count = 0    (model is alive but slow tail)
 *   false         true                     count = 0    (clean progress, all good)
 *   false         false                    count unchanged (e.g. non-timeout error;
 *                                                          don't poison or reset)
 *
 * The "false / false" branch matters: a non-timeout error attempt with no
 * completed progress should not reset the breaker (it isn't a sign the
 * provider is healthy), but it also shouldn't increment it (the issue at hand
 * is idle timeouts, not arbitrary errors).
 *
 * `outputTokens` is intentionally not part of the reset condition. Some
 * transports can accumulate billed output tokens from partial tool-call
 * argument deltas before the model stalls; those tokens are cost, not completed
 * progress, so they must not keep the breaker disarmed.
 */
export function stepIdleTimeoutBreaker(
  state: IdleTimeoutBreakerState,
  input: IdleTimeoutBreakerInput,
  options?: { cap?: number },
): IdleTimeoutBreakerStep {
  const cap = options?.cap ?? MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT;

  if (input.idleTimedOut && !input.completedModelProgress) {
    state.consecutiveIdleTimeoutsBeforeOutput += 1;
  } else if (input.completedModelProgress) {
    state.consecutiveIdleTimeoutsBeforeOutput = 0;
  }

  return {
    consecutive: state.consecutiveIdleTimeoutsBeforeOutput,
    tripped: cap > 0 && state.consecutiveIdleTimeoutsBeforeOutput >= cap,
  };
}
