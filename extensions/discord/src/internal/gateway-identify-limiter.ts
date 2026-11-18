const IDENTIFY_WINDOW_MS = 5_000;

class GatewayIdentifyLimiter {
  private nextAllowedAt = 0;

  // Runs `identify` once the shared window is free; it returns whether it sent IDENTIFY.
  // Only a sent IDENTIFY claims the window: a caller whose socket was replaced while
  // waiting must not reserve one, or abandoned waits push the queue ahead of real time.
  async schedule(identify: () => boolean): Promise<void> {
    for (;;) {
      const waitMs = this.nextAllowedAt - performance.now();
      if (waitMs <= 0) {
        break;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, waitMs).unref();
      await promise;
    }
    if (identify()) {
      this.nextAllowedAt = performance.now() + IDENTIFY_WINDOW_MS;
    }
  }

  reset(): void {
    this.nextAllowedAt = 0;
  }
}

export const sharedGatewayIdentifyLimiter = new GatewayIdentifyLimiter();
