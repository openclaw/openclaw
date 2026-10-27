import type { Worker } from "node:worker_threads";
import {
  resolveWorkspaceWorkerExecArgv,
  resolveWorkspaceWorkerUrl,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createSubsystemLogger,
  resolveGlobalSingleton,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createCpuTrackedWorker } from "openclaw/plugin-sdk/process-runtime";
import type { MemoryFileWatcherOptions } from "./file-watcher.js";
import type {
  LocalWatchCommand,
  LocalWatchEvent,
  MemoryWatchFacts,
} from "./local-watch-protocol.js";

const log = createSubsystemLogger("memory");
const owner = resolveGlobalSingleton(
  Symbol.for("openclaw.memory.localWatchTransport"),
  (): { transport?: MemoryWatchTransport } => ({}),
);

const RESTART_DELAYS_MS = [500, 2_000, 5_000];
const FAILURE_WINDOW_MS = 60_000;
type WorkerRun = {
  worker: Worker;
  exited: ReturnType<typeof createDeferred<void>>;
  failure?: Error;
};
type Subscription = { watcher: LocalMemoryFileWatcher; closing: boolean };

class MemoryWatchTransport {
  private run?: WorkerRun;
  private readonly subscriptions = new Map<number, Subscription>();
  private nextId = 0;
  private failures: number[] = [];
  private failure?: { error: Error; exhausted: boolean };
  private restartTimer?: ReturnType<typeof setTimeout>;
  private retirement?: Promise<void>;

  get retiring(): boolean {
    return Boolean(this.retirement);
  }

  private startWorker(): void {
    let run: WorkerRun;
    try {
      run = {
        worker: createCpuTrackedWorker(resolveWorkspaceWorkerUrl("memory"), {
          execArgv: resolveWorkspaceWorkerExecArgv("memory"),
          name: "memory-files",
        }),
        exited: createDeferred<void>(),
      };
    } catch (error) {
      this.recover(toErrorObject(error, "Memory file worker failed to start"));
      return;
    }
    this.run = run;
    this.failure = undefined;
    run.worker.on("message", (event: LocalWatchEvent) => {
      if (event.type === "shutdown") {
        if (event.error) {
          run.failure = new Error(event.error);
          // Native close failed; joining termination releases any remaining handles.
          void run.worker.terminate().catch((error: unknown) => run.exited.reject(error));
        }
      } else {
        this.subscriptions.get(event.id)?.watcher.receive(event);
      }
    });
    run.worker.on("error", (error) => {
      run.failure = toErrorObject(error, "Memory file worker failed");
    });
    run.worker.on("exit", (code) => {
      this.run = undefined;
      if (!this.retiring || code !== 0) {
        run.failure ??= new Error(`Memory file worker exited unexpectedly (${code})`);
      }
      run.exited.resolve();
      if (!this.retiring && run.failure) {
        this.recover(run.failure);
      }
    });
    for (const [id, { watcher, closing }] of this.subscriptions) {
      if (!closing) {
        // Rebuilding through the existing owner restores shared scopes and its
        // baseline reconciliation catches edits missed while the worker was down.
        run.worker.postMessage(watcher.openCommand(id), []);
      }
    }
  }

  private recover(error: Error): void {
    if (![...this.subscriptions.values()].some((entry) => !entry.closing)) {
      return;
    }
    const now = Date.now();
    this.failures = this.failures.filter((time) => now - time < FAILURE_WINDOW_MS);
    this.failures.push(now);
    const delay = RESTART_DELAYS_MS[this.failures.length - 1];
    const message =
      delay === undefined
        ? `Memory file worker unavailable after repeated failures; restart the Gateway to retry: ${error.message}`
        : `Memory file worker unavailable; restarting in ${delay} ms: ${error.message}`;
    log.warn(message);
    const failure = new Error(message);
    this.failure = { error: failure, exhausted: delay === undefined };
    for (const { watcher, closing } of this.subscriptions.values()) {
      if (!closing) {
        watcher.failed(failure, delay === undefined);
      }
    }
    if (delay !== undefined) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.startWorker();
      }, delay);
      this.restartTimer.unref();
    }
  }

  add(watcher: LocalMemoryFileWatcher): number {
    const id = ++this.nextId;
    this.subscriptions.set(id, { watcher, closing: false });
    if (this.failure) {
      watcher.failed(this.failure.error, this.failure.exhausted);
    } else if (this.run) {
      this.run.worker.postMessage(watcher.openCommand(id), []);
    } else if (!this.restartTimer) {
      this.startWorker();
    }
    return id;
  }

  async remove(id: number, retired: Promise<void>): Promise<void> {
    this.subscriptions.get(id)!.closing = true;
    const run = this.run;
    try {
      if (run) {
        if (!run.failure) {
          run.worker.postMessage({ type: "close", id } satisfies LocalWatchCommand, []);
        }
        // An unexpected exit also retires every native subscription it owned.
        await Promise.race([retired, run.exited.promise]);
        if (run.failure) {
          await run.exited.promise;
          throw run.failure;
        }
      }
    } finally {
      this.subscriptions.delete(id);
      if (!this.subscriptions.size) {
        clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        this.retirement = (async () => {
          const active = this.run;
          try {
            if (active) {
              active.worker.postMessage({ type: "shutdown" } satisfies LocalWatchCommand, []);
              await active.exited.promise;
              if (active.failure) {
                throw active.failure;
              }
            }
          } finally {
            owner.transport = undefined;
          }
        })();
        await this.retirement;
      }
    }
  }

  async waitForExit(): Promise<void> {
    await this.retirement;
  }
}

/** Local proxy; the shared file worker owns traversal, native watches and settling. */
export class LocalMemoryFileWatcher {
  private facts: MemoryWatchFacts = { health: [], capacityDegraded: false };
  private readonly ready = createDeferred<void>();
  private readonly retired = createDeferred<void>();
  private attachment?: Promise<void>;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private syncing?: Promise<void>;
  private transport?: MemoryWatchTransport;
  private id?: number;
  private closed = false;
  private settled = false;

  constructor(private readonly options: MemoryFileWatcherOptions) {
    // A worker failure may precede the caller joining start or close.
    void this.ready.promise.catch(() => undefined);
    void this.retired.promise.catch(() => undefined);
  }

  get capacityDegraded(): boolean {
    return this.facts.capacityDegraded;
  }

  health(): MemoryWatchFacts["health"] {
    return this.facts.health;
  }

  start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }
    this.attachment = (async () => {
      // Final retirement joins native cleanup and exit before a new owner starts.
      while (owner.transport?.retiring) {
        await owner.transport.waitForExit();
      }
      if (this.closed) {
        this.ready.resolve();
        return;
      }
      const transport = (owner.transport ??= new MemoryWatchTransport());
      this.transport = transport;
      this.id = transport.add(this);
    })();
    this.starting = this.attachment.then(() => this.ready.promise);
    return this.starting;
  }

  openCommand(id: number): Extract<LocalWatchCommand, { type: "open" }> {
    return {
      type: "open",
      id,
      workspaceDir: this.options.workspaceDir,
      request: {
        agentId: this.options.agentId,
        settings: {
          extraPaths: this.options.settings.extraPaths,
          multimodal: this.options.settings.multimodal,
          sync: { watchDebounceMs: this.options.settings.sync.watchDebounceMs },
        },
      },
    };
  }

  receive(event: Exclude<LocalWatchEvent, { type: "shutdown" }>): void {
    if (event.type === "closed") {
      if (event.error) {
        const error = new Error(event.error);
        this.ready.reject(error);
        this.retired.reject(error);
      } else {
        this.ready.resolve();
        this.retired.resolve();
      }
      return;
    }
    if (event.type === "started") {
      this.ready.resolve();
    }
    if (event.type === "started" || event.type === "state") {
      this.facts = event.facts;
    }
    if (this.closed) {
      return;
    }
    try {
      this.options.runInBackgroundContext(() => {
        switch (event.type) {
          case "started":
          case "state":
            this.options.onState?.(event.facts);
            break;
          case "dirty":
            // A newer edit invalidates a settled notification waiting behind indexing.
            this.settled = false;
            this.options.onDirty?.();
            break;
          case "change":
            this.settled = true;
            this.drainChanges();
            break;
          case "unavailable":
            this.options.onUnavailable();
            break;
        }
      });
    } catch (error) {
      log.warn(`memory watch callback failed: ${String(error)}`);
    }
  }

  private drainChanges(): void {
    if (this.syncing || !this.settled || this.closed) {
      return;
    }
    this.settled = false;
    this.syncing = Promise.resolve()
      .then(() => this.options.runInBackgroundContext(() => this.options.onChange()))
      .catch((error: unknown) => {
        log.warn(`memory sync failed (watch): ${String(error)}`);
      })
      .finally(() => {
        this.syncing = undefined;
        this.drainChanges();
      });
  }

  failed(error: Error, exhausted: boolean): void {
    const health = this.facts.health.length
      ? this.facts.health
      : [
          {
            state: "unavailable" as const,
            mode: "events" as const,
            directories: 0,
            failure: undefined,
            pollingFallback: false,
            pollIntervalMs: 0,
          },
        ];
    this.receive({
      id: this.id!,
      type: "state",
      facts: {
        capacityDegraded: true,
        health: health.map((entry) => ({
          state: "unavailable",
          mode: entry.mode,
          directories: 0,
          pollingFallback: entry.pollingFallback,
          pollIntervalMs: entry.pollIntervalMs,
          failure: { operation: "watch", code: "worker-unavailable", error: error.message },
        })),
      },
    });
    if (exhausted) {
      this.ready.reject(error);
    }
    this.receive({ id: this.id!, type: "dirty" });
    this.receive({ id: this.id!, type: "unavailable" });
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.attachment;
        if (this.transport && this.id !== undefined) {
          await this.transport.remove(this.id, this.retired.promise);
        }
      } finally {
        this.ready.resolve();
        await this.syncing;
      }
    })();
    return this.closing;
  }
}
