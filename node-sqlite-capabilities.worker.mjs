import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { probeSqlite } from "./node-sqlite-capabilities.mjs";

if (!parentPort) {
  throw new Error("SQLite capability entry requires a worker thread");
}
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort uses its worker channel without a target origin.
parentPort.postMessage(probeSqlite(DatabaseSync));
parentPort.close();
