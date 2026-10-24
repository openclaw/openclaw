import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { computeBackoff } from "openclaw/plugin-sdk/runtime-env";
import {
  isNonRecoverableSlackAuthError,
  SLACK_SOCKET_RECONNECT_POLICY,
} from "./reconnect-policy.js";

/**
 * Single-flight Slack identity recovery. Recovery otherwise runs only on socket start or
 * inbound events, so a stable socket with no traffic would keep a transient auth.test
 * failure forever; failures retry with backoff while the transport stays connected.
 */
export function createSlackIdentityRecovery(params: {
  scheduler: PluginServiceSchedulerV1;
  isBlocked: () => boolean;
  /** Resolves false when the recovered identity is not adopted; throws on failure. */
  attempt: () => Promise<boolean>;
  onFailure: (err: unknown) => void;
  onRetryRecovered: () => void;
}) {
  const scheduler = params.scheduler.scope();
  let attempts = 0;
  let retry: { cancel: () => void } | undefined;
  // Cancel only stops future dispatch, so an auth.test already in flight must recheck
  // this after it settles before publishing or rearming.
  let transportConnected = false;
  let inFlight: Promise<boolean> | undefined;

  function cancelRetry() {
    retry?.cancel();
    retry = undefined;
  }

  function scheduleRetry(err: unknown) {
    if (!transportConnected || isNonRecoverableSlackAuthError(err) || scheduler.signal.aborted) {
      return;
    }
    attempts += 1;
    retry = scheduler.schedule({
      id: "identity-recovery",
      delayMs: computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, attempts),
      run: async () => {
        if ((await recover()) && transportConnected) {
          params.onRetryRecovered();
        }
      },
    });
  }

  async function recover(): Promise<boolean> {
    if (!params.isBlocked()) {
      return false;
    }
    if (inFlight) {
      return await inFlight;
    }
    const recovery = (async () => {
      try {
        if (!(await params.attempt())) {
          return false;
        }
        attempts = 0;
        cancelRetry();
        return true;
      } catch (err) {
        params.onFailure(err);
        scheduleRetry(err);
        return false;
      }
    })();
    inFlight = recovery;
    try {
      return await recovery;
    } finally {
      if (inFlight === recovery) {
        inFlight = undefined;
      }
    }
  }

  return {
    recover,
    connected() {
      transportConnected = true;
    },
    disconnected() {
      transportConnected = false;
      cancelRetry();
    },
    async stop() {
      transportConnected = false;
      await scheduler.stop();
    },
  };
}
