// Proof-only fault injector: preserve the physical service and block its JS event loop.
import { workerData } from "node:worker_threads";
import pg from "pg";

// Capture the driver method; Reflect.apply below preserves each client's receiver.
// oxlint-disable-next-line typescript/unbound-method
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  if (args[0] === "SELECT 424242 AS pg_pool_service_hang") {
    Atomics.store(new Int32Array(workerData.proofEntered), 0, 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return Reflect.apply(query, this, args);
};
await import(workerData.proofServiceUrl);
