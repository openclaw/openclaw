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
    const random = params.random ?? Math.random;

    // Use recursive setTimeout instead of setInterval to prevent a race where
    // the first heartbeat fires near the end of the random-delay window and the
    // first setInterval tick fires before the ACK can arrive.
    //
    // With the old code:
    //   - firstHeartbeatTimeout fires at T0 + intervalMs * random()
    //   - heartbeatInterval first tick fires at T0 + intervalMs
    //   - If random() ≈ 1.0, the heartbeat was JUST sent; isAcked() is still
    //     false because the round-trip hasn't completed, triggering a false
    //     "Gateway heartbeat ACK timeout" and a needless reconnect.
    //
    // With recursive setTimeout the ACK check always runs a full intervalMs
    // AFTER the preceding heartbeat was sent, giving Discord enough time to
    // respond regardless of when the initial random-delay heartbeat fired.
    const scheduleNext = (): void => {
      this.heartbeatInterval = setTimeout(() => {
        if (!params.isAcked()) {
          params.onAckTimeout();
          return;
        }
        params.onHeartbeat();
        scheduleNext();
      }, params.intervalMs);
      this.heartbeatInterval.unref?.();
    };

    this.firstHeartbeatTimeout = setTimeout(
      () => {
        params.onHeartbeat();
        scheduleNext();
      },
      Math.max(0, params.intervalMs * random()),
    );
    this.firstHeartbeatTimeout.unref?.();
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearTimeout(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.firstHeartbeatTimeout) {
      clearTimeout(this.firstHeartbeatTimeout);
      this.firstHeartbeatTimeout = undefined;
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
