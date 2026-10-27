import type { Worker } from "node:worker_threads";
import {
  createCpuTrackedWorker,
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { pluginFilesLocation } from "./plugin-files.js";
import type { RegistryOperations, RegistryRequest, RegistryResponse } from "./registry-host.js";
import { sdkUrls } from "./storage-client.js";
import type { RegistrySnapshot } from "./store-registry.js";

type Pending = { resolve(value: unknown): void; reject(error: unknown): void };
const registryEntrypoint = createPluginRuntimeProcessEntrypoint(
  "knowledgeRegistry",
  import.meta.url,
);
/** Registry failure that needs operator recovery, not a retry. */
export class RegistryUnavailable extends Error {}

/** Main-thread handle to the registry worker. It installs each published
 * snapshot so store resolution can read registry facts synchronously. */
export class RegistryClient {
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  /** Latest published registry facts; undefined until the first load. */
  current?: RegistrySnapshot;
  /** Set when the registry cannot be opened; every store is then unavailable. */
  failure?: RegistryUnavailable;
  /** `stateRoot` resolves on first use: plugin registration may run where the
   * host runtime is unavailable (CLI metadata), so construction must not ask. */
  constructor(private readonly stateRoot: () => string) {}

  /** Call a registry operation. Operations that return a snapshot publish it. */
  async call<Op extends keyof RegistryOperations>(
    op: Op,
    ...args: Parameters<RegistryOperations[Op]>
  ): Promise<ReturnType<RegistryOperations[Op]>> {
    const worker = this.start(),
      id = ++this.nextId;
    const value = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, op, args } satisfies RegistryRequest, []);
    });
    if (value && typeof value === "object" && "bindings" in value && "stores" in value) {
      // SAFETY: only snapshot-returning registry operations answer with both bindings and stores.
      this.current = value as RegistrySnapshot;
    }
    // SAFETY: the registry worker answers each operation with that operation's return value.
    return value as ReturnType<RegistryOperations[Op]>;
  }
  /** Load (or reload) published facts. */
  async load(): Promise<RegistrySnapshot> {
    try {
      this.failure = undefined;
      return await this.call("snapshot");
    } catch (e) {
      if (e instanceof RegistryUnavailable) {
        this.failure = e;
      }
      throw e;
    }
  }
  close() {
    const worker = this.worker;
    this.worker = undefined;
    this.fail(new Error("Knowledge store registry stopped; retry the original request."));
    void worker?.terminate();
  }
  private start(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = createCpuTrackedWorker(resolveRuntimeWorkerUrl(registryEntrypoint), {
      workerData: { sdk: sdkUrls(), files: pluginFilesLocation(), stateRoot: this.stateRoot() },
    });
    worker.unref();
    worker.on("message", (message: RegistryResponse) => {
      const call = this.pending.get(message.id);
      if (!call) {
        return;
      }
      this.pending.delete(message.id);
      if (!this.pending.size) {
        worker.unref();
      }
      if (message.ok) {
        call.resolve(message.value);
      } else {
        call.reject(
          message.recovery ? new RegistryUnavailable(message.message) : new Error(message.message),
        );
      }
    });
    worker.on("error", (error) => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.fail(error);
      }
    });
    worker.on("exit", () => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.fail(new Error("Knowledge store registry worker exited; retry the original request."));
      }
    });
    this.worker = worker;
    return worker;
  }
  private fail(error: unknown) {
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      call.reject(error);
    }
  }
}
