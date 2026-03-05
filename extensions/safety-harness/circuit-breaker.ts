// extensions/safety-harness/circuit-breaker.ts
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 5 * 60_000; // 5 minutes

export class CircuitBreaker {
  private failureTimestamps: number[] = [];
  private _state: "closed" | "open" = "closed";

  get state(): "closed" | "open" {
    return this._state;
  }

  isDegraded(): boolean {
    return this._state === "open";
  }

  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.pruneOld(now);

    if (this.failureTimestamps.length >= FAILURE_THRESHOLD) {
      this._state = "open";
    }
  }

  recordSuccess(): void {
    this.failureTimestamps = [];
    this._state = "closed";
  }

  private pruneOld(now: number): void {
    const cutoff = now - WINDOW_MS;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t > cutoff);
  }
}
