import type { OscClient } from "./osc-client.js";

type MonitorOptions = {
  client: OscClient;
  onAlert: (message: string, sessionKey: string) => void;
  lowBatteryThreshold: number;
  lowStorageMB: number;
  pollIntervalMs: number;
};

export class RecordingMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionKey: string | null = null;
  private disconnectCount = 0;
  private readonly opts: MonitorOptions;
  private lastAlert: string | null = null;

  constructor(opts: MonitorOptions) {
    this.opts = opts;
  }

  start(sessionKey: string): void {
    this.stop();
    this.sessionKey = sessionKey;
    this.disconnectCount = 0;
    this.lastAlert = null;
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.opts.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessionKey = null;
    this.disconnectCount = 0;
    this.lastAlert = null;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  private alert(message: string): void {
    if (!this.sessionKey || message === this.lastAlert) return;
    this.lastAlert = message;
    this.opts.onAlert(message, this.sessionKey);
  }

  private async poll(): Promise<void> {
    if (!this.sessionKey) return;

    let state: Record<string, unknown>;
    try {
      const response = await this.opts.client.getState();
      state = (response.state ?? response) as Record<string, unknown>;
      this.disconnectCount = 0;
    } catch {
      this.disconnectCount++;
      if (this.disconnectCount >= 2) {
        this.alert("Camera disconnected during recording. Check WiFi connection.");
      }
      return;
    }

    const batteryLevel = typeof state.batteryLevel === "number" ? state.batteryLevel : 1;
    const batteryPct = Math.round(batteryLevel * 100);
    if (batteryPct <= this.opts.lowBatteryThreshold) {
      this.alert(`Low battery: ${batteryPct}%. Consider stopping recording.`);
    }

    const storageMB =
      typeof state._storageRemainInMB === "number" ? state._storageRemainInMB : Infinity;
    if (storageMB <= this.opts.lowStorageMB) {
      this.alert(`Low storage: ${Math.round(storageMB)}MB remaining. Consider stopping recording.`);
    }
  }
}
