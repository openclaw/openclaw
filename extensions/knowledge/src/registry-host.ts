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
      | "grant"
      | "personGrant"
  ]: StoreRegistry[K];
};
export type RegistryRequest = {
  id: number;
  op: keyof RegistryOperations;
  args: unknown[];
  authority?: SharedArrayBuffer;
};
export type RegistryResponse =
  | { id: number; type: "assert" }
  | { id: number; type: "result"; ok: true; value: unknown }
  | { id: number; type: "result"; ok: false; message: string; recovery: boolean };

/** Serve registry calls one at a time. An unopenable registry answers every
 * call with a recovery error instead of creating a replacement. */
export function serveRegistry(port: MessagePort, stateRoot: string) {
  let registry: StoreRegistry | undefined, failure: Error | undefined;
  // Registry operations are synchronous and serialized on this worker. Only
  // the active request may ask its original host owner to publish a grant.
  let invocation: RegistryRequest | undefined;
  const assertGrantCurrent = () => {
    if (!invocation?.authority) {
      throw new Error("Person grant publication requires live operator authority.");
    }
    const signal = new Int32Array(invocation.authority);
    port.postMessage({ id: invocation.id, type: "assert" } satisfies RegistryResponse);
    Atomics.wait(signal, 0, 0, 10000);
    if (Atomics.load(signal, 1) !== 1) {
      throw new Error("Operator authority ended before grant publication. Nothing was changed.");
    }
  };
  try {
    registry = new StoreRegistry(stateRoot, { assertGrantCurrent });
  } catch (e) {
    // SAFETY: registry opening throws Error instances (filesystem, SQLite or recovery errors).
    failure = e as Error;
  }
  port.on("message", (request: RegistryRequest) => {
    try {
      if (!registry) {
        throw failure!;
      }
      invocation = request;
      // SAFETY: registry requests name only RegistryOperations methods, sent by RegistryClient.
      const run = registry[request.op] as (...args: unknown[]) => unknown;
      port.postMessage({
        id: request.id,
        type: "result",
        ok: true,
        value: run.apply(registry, request.args),
      } satisfies RegistryResponse);
    } catch (e) {
      port.postMessage({
        id: request.id,
        type: "result",
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        recovery: e instanceof RegistryRecoveryRequired || !registry,
      } satisfies RegistryResponse);
    } finally {
      invocation = undefined;
    }
  });
}
