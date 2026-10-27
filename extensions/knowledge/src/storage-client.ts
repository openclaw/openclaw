import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import {
  createCpuTrackedWorker,
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import type { VaultAccess } from "./access.js";
import { pluginFilesLocation } from "./plugin-files.js";
import type { StoreConfig } from "./real-vault.js";
import type { StorageOperations } from "./storage-host.js";
import { AUTHORITY_REVOKED, type HostMessage, type WorkerMessage } from "./storage-protocol.js";

type Output<Op extends keyof StorageOperations> = Awaited<ReturnType<StorageOperations[Op]>>;
type Input<Op extends keyof StorageOperations> = Parameters<StorageOperations[Op]>[2];
const storageEntrypoint = createPluginRuntimeProcessEntrypoint("knowledgeStorage", import.meta.url);
type Call = {
  access: VaultAccess;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  revoked?: unknown;
};

// SDK modules reachable from storage and registry code in the workers.
const SDK_MODULES = [
  "openclaw/plugin-sdk/feature-contract",
  "openclaw/plugin-sdk/routing",
  "openclaw/plugin-sdk/sqlite-worker-runtime",
];
// Resolve through whatever resolver the host installed for this plugin module.
export function sdkUrls(): Record<string, string> {
  const urls: Record<string, string> = {},
    require = createRequire(import.meta.url);
  for (const specifier of SDK_MODULES) {
    try {
      urls[specifier] = import.meta.resolve(specifier);
      continue;
    } catch {
      /* Fall back to CommonJS resolution. */
    }
    try {
      urls[specifier] = pathToFileURL(require.resolve(specifier)).href;
    } catch {
      /* The worker uses normal resolution. */
    }
  }
  return urls;
}

/** Main-thread handle to one store's storage worker. Authorization stays here: the
 * worker receives only the resolved scope and asks this thread to re-check the
 * caller's live authority whenever storage calls `access.assertCurrent`. */
export class StorageClient {
  private worker?: Worker;
  private readonly signal = new Int32Array(new SharedArrayBuffer(8));
  private readonly calls = new Map<number, Call>();
  private nextId = 0;
  constructor(readonly config: StoreConfig) {}
  call<Op extends keyof StorageOperations>(
    op: Op,
    access: VaultAccess,
    ...input: Input<Op> extends undefined ? [] : [Input<Op>]
  ): Promise<Output<Op>> {
    access.assertCurrent();
    const worker = this.start(),
      id = ++this.nextId;
    return new Promise<Output<Op>>((resolve, reject) => {
      // SAFETY: each call resolves with the output type of the operation it sent.
      this.calls.set(id, { access, resolve: resolve as (value: unknown) => void, reject });
      // Keep the process alive only while work is outstanding.
      worker.ref();
      worker.postMessage(
        {
          type: "call",
          id,
          op,
          input: input[0],
          scope: access.scope,
          agentId: access.agentId,
          activity: access.activity,
        } satisfies HostMessage<keyof StorageOperations>,
        [],
      );
    });
  }
  /** Stop the worker. Outstanding calls fail; the next call starts a new worker. */
  close() {
    const worker = this.worker;
    this.worker = undefined;
    this.fail(new Error("Knowledge storage stopped; retry the original request."));
    void worker?.terminate();
  }
  private start(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = createCpuTrackedWorker(resolveRuntimeWorkerUrl(storageEntrypoint), {
      workerData: {
        sdk: sdkUrls(),
        files: pluginFilesLocation(),
        config: this.config,
        signal: this.signal.buffer,
      },
    });
    worker.unref();
    worker.on("message", (message: WorkerMessage) => this.receive(message, worker));
    worker.on("error", (error) => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.fail(error);
      }
    });
    worker.on("exit", () => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.fail(new Error("Knowledge storage worker exited; retry the original request."));
      }
    });
    this.worker = worker;
    return worker;
  }
  private receive(message: WorkerMessage, worker: Worker) {
    const call = this.calls.get(message.id);
    if (message.type === "assert") {
      // Answer through shared memory: the worker is blocked waiting for it.
      let current = false;
      try {
        call?.access.assertCurrent();
        current = Boolean(call);
      } catch (error) {
        if (call) {
          call.revoked = error;
        }
      }
      Atomics.store(this.signal, 1, current ? 1 : 2);
      Atomics.store(this.signal, 0, 1);
      Atomics.notify(this.signal, 0);
      return;
    }
    if (!call) {
      return;
    }
    this.calls.delete(message.id);
    if (!this.calls.size) {
      worker.unref();
    }
    if (message.ok) {
      call.resolve(message.value);
      return;
    }
    call.reject(
      call.revoked && message.message === AUTHORITY_REVOKED
        ? call.revoked
        : new Error(message.message),
    );
  }
  private fail(error: unknown) {
    const calls = [...this.calls.values()];
    this.calls.clear();
    for (const call of calls) {
      call.reject(error);
    }
  }
}
