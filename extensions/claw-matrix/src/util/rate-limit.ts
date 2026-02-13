/**
 * Simple token bucket rate limiter.
 * Prevents 429s from rapid-fire requests to the homeserver.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private maxTokens: number = 5,
    private refillRate: number = 1, // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      this.tokens = 0;
      this.lastRefill = Date.now();
    } else {
      this.tokens -= 1;
    }
  }
}
