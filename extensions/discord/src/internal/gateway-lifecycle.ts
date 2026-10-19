type GatewayTimer = NodeJS.Timeout;

export class GatewayHeartbeatTimers {
  heartbeatInterval?: GatewayTimer;
  firstHeartbeatTimeout?: GatewayTimer;

  start(params: {
    intervalMs: number;
    isAcked: () => boolean;
    onAckTimeout: () => void;
    onHeartbeat: () => void;
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
    this.firstHeartbeatTimeout = setTimeout(
      () => {
        this.firstHeartbeatTimeout = undefined;
        params.onHeartbeat();
        scheduleHeartbeatCycle();
      },
      Math.max(0, params.intervalMs * Math.random()),
    );
    this.firstHeartbeatTimeout.unref?.();
  }

  stop(): void {
    for (const key of ["heartbeatInterval", "firstHeartbeatTimeout"] as const) {
      clearTimeout(this[key]);
      this[key] = undefined;
    }
  }
}

export class GatewayReconnectTimer {
  timeout?: GatewayTimer;

  stop(): void {
    clearTimeout(this.timeout);
    this.timeout = undefined;
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
