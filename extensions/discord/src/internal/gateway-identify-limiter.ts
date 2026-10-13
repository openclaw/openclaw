const IDENTIFY_WINDOW_MS = 5_000;

type IdentifyRateState = {
  lastObservedAt: number;
  nextAllowedAt: number;
};

class GatewayIdentifyLimiter {
  private state: IdentifyRateState | undefined;

  async wait(): Promise<void> {
    const now = Date.now();
    const state = this.state;
    const clockMovedBackward = state !== undefined && now < state.lastObservedAt;
    const nextAllowedAt =
      state === undefined
        ? now
        : clockMovedBackward
          ? now + IDENTIFY_WINDOW_MS
          : state.nextAllowedAt;
    const waitMs = Math.max(0, nextAllowedAt - now);
    this.state = {
      lastObservedAt: now,
      nextAllowedAt: Math.max(now, nextAllowedAt) + IDENTIFY_WINDOW_MS,
    };
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      });
    }
  }

  reset(): void {
    this.state = undefined;
  }
}

export const sharedGatewayIdentifyLimiter = new GatewayIdentifyLimiter();
