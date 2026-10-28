import type { MessagePort } from "node:worker_threads";
import { RegistryRecoveryRequired, StoreRegistry } from "./store-registry.js";

/** Registry operations the main thread may request. */
export type RegistryOperations = {
  [
    K in
      | "snapshot"
      | "provision"
      | "adopt"
      | "reconcile"
      | "operation"
      | "begin"
      | "settle"
      | "label"
      | "maintenance"
  ]: StoreRegistry[K];
};
export type RegistryRequest = { id: number; op: keyof RegistryOperations; args: unknown[] };
export type RegistryResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; recovery: boolean };

/** Serve registry calls one at a time. An unopenable registry answers every
 * call with a recovery error instead of creating a replacement. */
export function serveRegistry(port: MessagePort, stateRoot: string) {
  let registry: StoreRegistry | undefined, failure: Error | undefined;
  try {
    registry = new StoreRegistry(stateRoot);
  } catch (e) {
    // SAFETY: registry opening throws Error instances (filesystem, SQLite or recovery errors).
    failure = e as Error;
  }
  port.on("message", (request: RegistryRequest) => {
    try {
      if (!registry) {
        throw failure!;
      }
      // SAFETY: registry requests name only RegistryOperations methods, sent by RegistryClient.
      const run = registry[request.op] as (...args: unknown[]) => unknown;
      port.postMessage({
        id: request.id,
        ok: true,
        value: run.apply(registry, request.args),
      } satisfies RegistryResponse);
    } catch (e) {
      port.postMessage({
        id: request.id,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        recovery: e instanceof RegistryRecoveryRequired || !registry,
      } satisfies RegistryResponse);
    }
  });
}
