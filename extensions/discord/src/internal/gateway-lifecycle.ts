type GatewayTimer = NodeJS.Timeout;

export class GatewayHeartbeatTimers {
  heartbeatInterval?: GatewayTimer;
  firstHeartbeatTimeout?: GatewayTimer;

  start(params: {
    intervalMs: number;
    isAcked: () => boolean;
    onAckTimeout: () => void;
    onHeartbeat: () => void;
    random?: () => number;
  }): void {
    this.stop();
    const scheduleHeartbeatCycle = () => {
      this.heartbeatInterval = setTimeout(() => {
        this.heartbeatInterval = undefined;
        if (!params.isAcked()) {
          params.onAckTimeout();
          return;
        }
        params.onHeartbeat();
        scheduleHeartbeatCycle();
      }, params.intervalMs);
      this.heartbeatInterval.unref?.();
    };
    const random = params.random ?? Math.random;
    this.firstHeartbeatTimeout = setTimeout(
      () => {
        this.firstHeartbeatTimeout = undefined;
        params.onHeartbeat();
        scheduleHeartbeatCycle();
      },
      Math.max(0, params.intervalMs * random()),
    );
    this.firstHeartbeatTimeout.unref?.();
  }

  stop(): void {
    for (const key of ["heartbeatInterval", "firstHeartbeatTimeout"] as const) {
      const timer = this[key];
      if (timer) {
        clearTimeout(timer);
        this[key] = undefined;
      }
    }
  }
}

export class GatewayReconnectTimer {
  timeout?: GatewayTimer;

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  schedule(delayMs: number, callback: () => void): void {
    this.stop();
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      callback();
    }, delayMs);
    this.timeout.unref?.();
  }
}
