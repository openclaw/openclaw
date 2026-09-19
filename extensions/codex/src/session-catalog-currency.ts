type CurrencyOptions = {
  local: boolean;
  reconcileFiles(): Promise<void>;
  reconcileNative(full: boolean): Promise<void>;
  runBackground?: (run: () => Promise<void>) => Promise<void>;
  report(error: unknown): void;
};

const SAFETY_INTERVAL_MS = 15 * 60_000;

/** One periodic reconciliation cycle per home, without a recursive watcher inventory. */
export class CodexCatalogCurrency {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private nativeDirty = false;
  private nextNativeAt = 0;
  private nextFilesAt = 0;

  constructor(private readonly options: CurrencyOptions) {}

  hasActiveWork(): boolean {
    return this.initial !== undefined || this.running !== undefined;
  }

  requestNativeRefresh(): void {
    this.nativeDirty = true;
  }

  start(): void {
    if (this.closed || this.timer) {
      return;
    }
    this.nextNativeAt = Date.now() + SAFETY_INTERVAL_MS;
    this.nextFilesAt = this.nextNativeAt;
    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }
      const startedAt = Date.now();
      const full = startedAt >= this.nextNativeAt;
      const filesDue = this.options.local && startedAt >= this.nextFilesAt;
      if (!full && !filesDue && !this.nativeDirty) {
        return;
      }
      const run = async () => {
        if (filesDue) {
          await this.options.reconcileFiles();
          this.nextFilesAt = startedAt + SAFETY_INTERVAL_MS;
        }
        if (full || this.nativeDirty) {
          // Consume before the read so notifications during it schedule another delta.
          this.nativeDirty = false;
          await this.options.reconcileNative(full);
          if (full) {
            this.nextNativeAt = startedAt + SAFETY_INTERVAL_MS;
          }
        }
      };
      this.running = (this.options.runBackground ? this.options.runBackground(run) : run())
        .catch((error: unknown) => {
          this.nativeDirty = true;
          this.options.report(error);
        })
        .finally(() => {
          this.running = undefined;
        });
    }, 30_000);
    this.timer.unref();
    if (this.options.local) {
      // Restored snapshots serve immediately; the initial delta scan runs separately.
      this.initial = setTimeout(() => {
        this.initial = undefined;
        void this.options.reconcileFiles().catch((error: unknown) => this.options.report(error));
      }, 0);
      this.initial.unref();
    }
  }

  close(): Promise<void> | undefined {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.initial);
    this.initial = undefined;
    return this.running;
  }
}
