import { probeTelegram } from "./probe.js";

export type HeartbeatSupervisorOpts = {
  /** Pre-resolved Telegram API base URL (e.g. "https://api.telegram.org"). */
  apiBase: string;
  token: string;
  /** Optional proxy URL forwarded to each probe (e.g. "http://proxy:3128"). */
  proxyUrl?: string;
  /** Shared abort signal; heartbeat stops when aborted. */
  abortSignal?: AbortSignal;
  /** How often to run a probe (ms). @default 30_000 */
  intervalMs?: number;
  /** Number of consecutive failures before firing onOutageDetected. @default 3 */
  failureThreshold?: number;
  /** Timeout budget for each probe call (ms). @default 10_000 */
  probeTimeoutMs?: number;
  /** Called once after failureThreshold consecutive probe failures. */
  onOutageDetected: () => void;
  /** Called once after a successful probe following an outage. */
  onRecovered: () => void;
  log: (line: string) => void;
};

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Threshold-based heartbeat supervisor for Telegram API connectivity.
 *
 * Runs periodic silent probes via probeTelegram(). Fires onOutageDetected
 * after exactly `failureThreshold` consecutive failures (once per outage),
 * and fires onRecovered once when a subsequent probe succeeds.
 *
 * Call start() once; call stop() in a finally block.
 */
export class HeartbeatSupervisor {
  #intervalHandle: ReturnType<typeof setInterval> | undefined;
  #consecutiveFailures = 0;
  #inOutage = false;
  #probeInFlight = false;
  #stopped = false;

  readonly #intervalMs: number;
  readonly #failureThreshold: number;
  readonly #probeTimeoutMs: number;

  constructor(private readonly opts: HeartbeatSupervisorOpts) {
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  start(): void {
    if (this.#intervalHandle !== undefined) {
      return;
    }
    this.#stopped = false;
    this.#intervalHandle = setInterval(() => {
      void this.#tick();
    }, this.#intervalMs);
    // Allow Node to exit even if the interval is still pending.
    this.#intervalHandle.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#intervalHandle !== undefined) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = undefined;
    }
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.opts.abortSignal?.aborted || this.#probeInFlight) {
      return;
    }

    this.#probeInFlight = true;
    try {
      const result = await probeTelegram(this.opts.token, this.#probeTimeoutMs, {
        apiRoot: this.opts.apiBase,
        proxyUrl: this.opts.proxyUrl,
      });

      if (this.#stopped || this.opts.abortSignal?.aborted) {
        return;
      }

      if (result.ok) {
        if (this.#inOutage) {
          this.#inOutage = false;
          this.opts.onRecovered();
        }
        this.#consecutiveFailures = 0;
      } else {
        this.#consecutiveFailures += 1;
        this.opts.log(
          `[telegram][heartbeat] probe failed (${result.error ?? "unknown error"}) [${this.#consecutiveFailures}/${this.#failureThreshold}]`,
        );
        if (this.#consecutiveFailures >= this.#failureThreshold && !this.#inOutage) {
          this.#inOutage = true;
          this.opts.onOutageDetected();
        }
      }
    } finally {
      this.#probeInFlight = false;
    }
  }
}
