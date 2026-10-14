import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  findCodexAppServerSpawnError,
  reportCodexCatalogSpawnFailure,
  type CodexAppServerSpawnError,
} from "./app-server/spawn-error.js";

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
  private hydration: NodeJS.Immediate | undefined;
  private terminalFailure: CodexAppServerSpawnError | undefined;
  private running: Promise<void> | undefined;
  private safetyRefresh: Promise<void> | undefined;
  private closed = false;
  private nativeDirty = false;
  private nextNativeAt = 0;
  private nextFilesAt = 0;

  constructor(private readonly options: CurrencyOptions) {}

  hasActiveWork(): boolean {
    return (
      this.hydration !== undefined ||
      this.initial !== undefined ||
      this.running !== undefined ||
      this.safetyRefresh !== undefined
    );
  }

  assertRunnable(): void {
    if (this.terminalFailure) {
      throw this.terminalFailure;
    }
  }

  stopForTerminalFailure(error: unknown): boolean {
    const failure = findCodexAppServerSpawnError(error);
    if (!failure) {
      return false;
    }
    if (!this.closed) {
      this.terminalFailure = failure;
      void this.close();
      reportCodexCatalogSpawnFailure(failure);
    }
    return true;
  }

  scheduleHydration(run: () => Promise<void>): void {
    if (this.closed || this.hydration) {
      return;
    }
    this.hydration = setImmediate(() => {
      this.hydration = undefined;
      void (this.options.runBackground ? this.options.runBackground(run) : run()).catch(
        (error: unknown) => this.options.report(error),
      );
    });
    this.hydration.unref();
  }

  cancelHydration(): void {
    clearImmediate(this.hydration);
    this.hydration = undefined;
  }

  requestNativeRefresh(): void {
    this.nativeDirty = true;
  }

  /** Full safety walks serve catalog demand; an idle resident index does not start one. */
  refreshNativeIfDue(): Promise<void> {
    if (this.closed || !this.timer || Date.now() < this.nextNativeAt) {
      return Promise.resolve();
    }
    if (this.safetyRefresh) {
      return this.safetyRefresh;
    }

    const refresh = async () => {
      if (this.running) {
        await this.running;
      }
      if (this.closed || Date.now() < this.nextNativeAt) {
        return;
      }
      const run = () => this.options.reconcileNative(true);
      await Promise.resolve()
        .then(() => (this.options.runBackground ? this.options.runBackground(run) : run()))
        .catch((error: unknown) => {
          this.options.report(
            new Error(
              `Codex catalog reconciliation failed; waiting for the next safety interval and catalog demand: ${coerceErrorMessage(error)}`,
              { cause: error },
            ),
          );
        });
      // A failed walk must not restart on every busy catalog read.
      this.nextNativeAt = Date.now() + SAFETY_INTERVAL_MS;
    };
    this.safetyRefresh = refresh().finally(() => {
      this.safetyRefresh = undefined;
    });
    return this.safetyRefresh;
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
      const filesDue = this.options.local && startedAt >= this.nextFilesAt;
      const nativeDue = this.nativeDirty && !this.safetyRefresh;
      if (!filesDue && !nativeDue) {
        return;
      }
      // Consume only work admitted to this cycle; activity stays queued during a full walk.
      if (nativeDue) {
        this.nativeDirty = false;
      }
      if (filesDue) {
        this.nextFilesAt = startedAt + SAFETY_INTERVAL_MS;
      }
      const run = async () => {
        if (filesDue) {
          await this.options.reconcileFiles();
        }
        if (nativeDue) {
          await this.options.reconcileNative(false);
        }
      };
      this.running = (this.options.runBackground ? this.options.runBackground(run) : run())
        .catch((error: unknown) => {
          this.options.report(
            new Error(
              `Codex catalog reconciliation failed; waiting for new activity or the next file safety cycle: ${coerceErrorMessage(error)}`,
              { cause: error },
            ),
          );
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
    this.cancelHydration();
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.initial);
    this.initial = undefined;
    if (this.running && this.safetyRefresh) {
      return Promise.allSettled([this.running, this.safetyRefresh]).then(() => {});
    }
    return this.running ?? this.safetyRefresh;
  }
}
