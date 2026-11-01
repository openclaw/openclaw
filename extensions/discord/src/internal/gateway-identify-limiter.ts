const IDENTIFY_WINDOW_MS = 5_000;

class GatewayIdentifyLimiter {
  private nextAllowedAt: number | undefined;

  async wait(): Promise<void> {
    const now = Date.now();
    const nextAllowedAt = this.nextAllowedAt ?? now;
    const waitMs = Math.max(0, nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, nextAllowedAt) + IDENTIFY_WINDOW_MS;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs).unref();
      });
    }
  }

  reset(): void {
    this.nextAllowedAt = undefined;
  }
}

export const sharedGatewayIdentifyLimiter = new GatewayIdentifyLimiter();
