// Token Bucket Rate Limiter for VRChat OSC
// Implements 5 messages / 5 seconds with 30 second jail on violation

export interface RateLimitConfig {
  bucketSize: number; // Maximum burst size (default: 5)
  refillRate: number; // Tokens per second (default: 1)
  jailDurationMs: number; // Jail time on violation (default: 30000ms)
}

export interface RateLimitState {
  tokens: number;
  lastRefill: number;
  inJail: boolean;
  jailEndTime: number;
  violationCount: number;
}

export class TokenBucketRateLimiter {
  private config: RateLimitConfig;
  private state: RateLimitState;
  private name: string;

  constructor(name: string, config: Partial<RateLimitConfig> = {}) {
    this.name = name;
    this.config = {
      bucketSize: 5,
      refillRate: 1,
      jailDurationMs: 30000,
      ...config,
    };

    this.state = {
      tokens: this.config.bucketSize,
      lastRefill: Date.now(),
      inJail: false,
      jailEndTime: 0,
      violationCount: 0,
    };
  }

  /**
   * Check if action is allowed and consume token if it is
   */
  allowAction(): { allowed: boolean; remaining: number; jailTimeRemaining?: number } {
    const now = Date.now();

    // Check if in jail
    if (this.state.inJail) {
      if (now < this.state.jailEndTime) {
        return {
          allowed: false,
          remaining: 0,
          jailTimeRemaining: this.state.jailEndTime - now,
        };
      }
      // Jail time expired
      this.state.inJail = false;
      this.state.tokens = this.config.bucketSize;
    }

    // Refill tokens based on time elapsed
    const timeElapsed = (now - this.state.lastRefill) / 1000;
    const tokensToAdd = timeElapsed * this.config.refillRate;

    this.state.tokens = Math.min(this.config.bucketSize, this.state.tokens + tokensToAdd);
    this.state.lastRefill = now;

    // Check if we have tokens available
    if (this.state.tokens >= 1) {
      this.state.tokens -= 1;
      return { allowed: true, remaining: Math.floor(this.state.tokens) };
    }

    // No tokens available - send to jail
    this.state.inJail = true;
    this.state.jailEndTime = now + this.config.jailDurationMs;
    this.state.violationCount += 1;

    return {
      allowed: false,
      remaining: 0,
      jailTimeRemaining: this.config.jailDurationMs,
    };
  }

  /**
   * Get current state without consuming tokens
   */
  getStatus(): {
    tokens: number;
    inJail: boolean;
    jailTimeRemaining: number;
    violationCount: number;
  } {
    const now = Date.now();

    if (this.state.inJail && now >= this.state.jailEndTime) {
      this.state.inJail = false;
    }

    return {
      tokens: Math.floor(this.state.tokens),
      inJail: this.state.inJail,
      jailTimeRemaining: this.state.inJail ? Math.max(0, this.state.jailEndTime - now) : 0,
      violationCount: this.state.violationCount,
    };
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.state = {
      tokens: this.config.bucketSize,
      lastRefill: Date.now(),
      inJail: false,
      jailEndTime: 0,
      violationCount: 0,
    };
  }
}

// Separate rate limiters for different operation types
export const rateLimiters = {
  chatbox: new TokenBucketRateLimiter("chatbox", {
    bucketSize: 5,
    refillRate: 1, // 1 token per second = 5 messages per 5 seconds
    jailDurationMs: 30000,
  }),
  input: new TokenBucketRateLimiter("input", {
    bucketSize: 20,
    refillRate: 20, // 20 per second
    jailDurationMs: 5000,
  }),
  camera: new TokenBucketRateLimiter("camera", {
    bucketSize: 10,
    refillRate: 10, // 10 per second
    jailDurationMs: 5000,
  }),
};

export function resetAllRateLimiters(): void {
  Object.values(rateLimiters).forEach((limiter) => limiter.reset());
}
