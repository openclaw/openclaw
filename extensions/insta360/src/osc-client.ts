/**
 * OSC HTTP client for Insta360 cameras.
 * Ensures serial command execution per OSC spec (never send a new command before the previous returns).
 */

export type OscResponse = Record<string, unknown>;

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"]);

const OSC_HEADERS = {
  "Content-Type": "application/json;charset=utf-8",
  Accept: "application/json",
  "X-XSRF-Protected": "1",
};

/** Maximum number of commands that may be waiting in the queue (not counting the active one). */
const QUEUE_DEPTH_LIMIT = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExecuteAndWaitOpts {
  /** Initial polling interval in ms (default 500). */
  pollStartMs?: number;
  /** Maximum polling interval after exponential back-off (default 5000). */
  pollMaxMs?: number;
  /** Total timeout in ms before throwing (default 60000). */
  timeoutMs?: number;
}

export class OscClient {
  private readonly baseUrl: string;

  /**
   * Tail of the promise chain — each enqueued command replaces this.
   * Initialised to a resolved promise so the first command starts immediately.
   */
  private mutex: Promise<unknown> = Promise.resolve();

  /** Number of commands currently waiting behind the active one. */
  private queueDepth = 0;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Execute fn through the serial mutex queue, enforcing the depth limit. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queueDepth >= QUEUE_DEPTH_LIMIT) {
      return Promise.reject(new Error("Camera busy, too many queued commands"));
    }

    this.queueDepth++;

    // Chain onto the current tail of the queue.
    // Errors must not block subsequent commands, so we always resolve the chain link.
    const next = this.mutex.then(
      () => {
        this.queueDepth--;
        return fn();
      },
      () => {
        // Previous command failed — still decrement and run next.
        this.queueDepth--;
        return fn();
      },
    );

    // Settle the chain so subsequent commands wait on `next` completing (not rejecting).
    this.mutex = next.then(
      () => {},
      () => {},
    );

    return next;
  }

  /**
   * Raw fetch with transient-error retry (single retry after 1 s for
   * ECONNREFUSED / ETIMEDOUT / ECONNRESET).
   */
  private async request(url: string, opts: RequestInit): Promise<OscResponse> {
    const attempt = async (): Promise<OscResponse> => {
      const res = await fetch(url, { ...opts, headers: OSC_HEADERS });
      if (!res.ok) {
        throw new Error(
          `OSC request failed: ${opts.method ?? "GET"} ${url} returned ${res.status}`,
        );
      }
      return res.json() as Promise<OscResponse>;
    };

    try {
      return await attempt();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && TRANSIENT_CODES.has(code)) {
        await delay(1000);
        return attempt();
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** GET /osc/info — camera model and capabilities. */
  getInfo(): Promise<OscResponse> {
    return this.enqueue(() => this.request(`${this.baseUrl}/osc/info`, { method: "GET" }));
  }

  /** POST /osc/state — current camera state (battery, capture status, …). */
  getState(): Promise<OscResponse> {
    return this.enqueue(() => this.request(`${this.baseUrl}/osc/state`, { method: "POST" }));
  }

  /** POST /osc/commands/execute — run a named OSC command with optional parameters. */
  execute(name: string, parameters?: Record<string, unknown>): Promise<OscResponse> {
    return this.enqueue(() =>
      this.request(`${this.baseUrl}/osc/commands/execute`, {
        method: "POST",
        body: JSON.stringify({ name, parameters }),
      }),
    );
  }

  /** POST /osc/commands/status — poll for the result of an async command. */
  pollCommandStatus(id: string): Promise<OscResponse> {
    return this.enqueue(() =>
      this.request(`${this.baseUrl}/osc/commands/status`, {
        method: "POST",
        body: JSON.stringify({ id }),
      }),
    );
  }

  /**
   * Execute a command and poll until it finishes (state !== "inProgress").
   * Uses exponential back-off between polls and throws on timeout.
   */
  async executeAndWait(
    name: string,
    parameters?: Record<string, unknown>,
    opts: ExecuteAndWaitOpts = {},
  ): Promise<OscResponse> {
    const pollStartMs = opts.pollStartMs ?? 500;
    const pollMaxMs = opts.pollMaxMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    const startAt = Date.now();
    let response = await this.execute(name, parameters);

    let interval = pollStartMs;

    while (response.state === "inProgress") {
      if (Date.now() - startAt >= timeoutMs) {
        throw new Error(`Command ${name} timed out after ${timeoutMs}ms`);
      }
      await delay(interval);
      // Double backoff, capped at pollMaxMs
      interval = Math.min(interval * 2, pollMaxMs);

      const id = response.id as string;
      response = await this.pollCommandStatus(id);
    }

    return response;
  }

  /**
   * Initialise the connection — required before first capture per OSC spec.
   * Returns both info and state so callers can inspect camera capabilities.
   */
  async init(): Promise<{ info: OscResponse; state: OscResponse }> {
    const info = await this.getInfo();
    const state = await this.getState();
    return { info, state };
  }
}
