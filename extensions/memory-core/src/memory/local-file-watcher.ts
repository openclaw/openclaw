import type { Worker } from "node:worker_threads";
import { resolveWorkspaceWorkerArgv } from "openclaw/plugin-sdk/agent-workspace-runtime";
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

class MemoryWatchTransport {
  private readonly worker: Worker;
  private readonly subscriptions = new Map<number, LocalMemoryFileWatcher>();
  private readonly exited = createDeferred<void>();
  private nextId = 0;
  private failure?: Error;
  retiring = false;

  constructor() {
    const argv = resolveWorkspaceWorkerArgv("memory");
    this.worker = createCpuTrackedWorker(argv.at(-1)!, {
      execArgv: argv.slice(0, -1),
      name: "memory-files",
    });
    this.worker.on("message", (event: LocalWatchEvent) => {
      if (event.type === "shutdown") {
        if (event.error) {
          this.fail(new Error(event.error));
          // Native close failed; joining termination releases any remaining handles.
          void this.worker.terminate().catch((error: unknown) => this.exited.reject(error));
        }
      } else {
        this.subscriptions.get(event.id)?.receive(event);
      }
    });
    this.worker.on("error", (error) =>
      this.fail(toErrorObject(error, "Memory file worker failed")),
    );
    this.worker.on("exit", (code) => {
      if (!this.retiring || code !== 0) {
        this.fail(new Error(`Memory file worker exited unexpectedly (${code})`));
      }
      this.exited.resolve();
    });
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const subscription of this.subscriptions.values()) {
      subscription.failed(this.failure);
    }
  }

  send(command: LocalWatchCommand): void {
    if (this.failure) {
      throw this.failure;
    }
    this.worker.postMessage(command, []);
  }

  add(subscription: LocalMemoryFileWatcher): number {
    if (this.failure) {
      throw this.failure;
    }
    const id = ++this.nextId;
    this.subscriptions.set(id, subscription);
    return id;
  }

  async remove(id: number, retired: Promise<void>): Promise<void> {
    if (this.failure) {
      this.subscriptions.delete(id);
      return this.waitForExit();
    }
    this.send({ type: "close", id });
    let closeError: Error | undefined;
    try {
      await retired;
    } catch (error) {
      closeError = toErrorObject(error, "Memory file watcher close failed");
    }
    this.subscriptions.delete(id);
    if (!this.subscriptions.size) {
      this.retiring = true;
      if (!this.failure) {
        this.send({ type: "shutdown" });
      }
      await this.waitForExit();
      owner.transport = undefined;
    } else if (this.failure) {
      await this.waitForExit();
    }
    if (closeError) {
      throw closeError;
    }
  }

  async waitForExit(): Promise<void> {
    await this.exited.promise;
    if (this.failure) {
      throw this.failure;
    }
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
      transport.send({
        type: "open",
        id: this.id,
        workspaceDir: this.options.workspaceDir,
        request: {
          agentId: this.options.agentId,
          settings: {
            extraPaths: this.options.settings.extraPaths,
            multimodal: this.options.settings.multimodal,
            sync: { watchDebounceMs: this.options.settings.sync.watchDebounceMs },
          },
        },
      });
    })();
    this.starting = this.attachment.then(() => this.ready.promise);
    return this.starting;
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

  failed(error: Error): void {
    this.facts = { health: [], capacityDegraded: false };
    this.ready.reject(error);
    this.retired.reject(error);
    if (!this.closed) {
      this.receive({ id: this.id!, type: "dirty" });
      this.receive({ id: this.id!, type: "unavailable" });
      log.warn(`memory workspace watcher unavailable: ${String(error)}`);
    }
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
        await this.syncing;
      }
    })();
    return this.closing;
  }
}
