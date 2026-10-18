import assert from "node:assert/strict";
import { mock } from "node:test";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { runVectorKnnInSubprocess } from "../manager-search-knn-subprocess.js";
import type { VectorKnnRequest } from "../manager-search-knn.js";

const input = process.argv[2];
assert.ok(input);
const {
  databasePaths,
  request,
  expireIdle,
}: {
  databasePaths: [string, string, string];
  request: VectorKnnRequest;
  expireIdle: boolean;
} = JSON.parse(input);
if (expireIdle) {
  mock.timers.enable({ apis: ["setTimeout"] });
}
for (const databasePath of databasePaths.slice(0, 2)) {
  await runVectorKnnInSubprocess({ databasePath, request });
}
if (expireIdle) {
  mock.timers.tick(SQLITE_IDLE_HANDLE_TTL_MS);
  mock.timers.reset();
}
await runVectorKnnInSubprocess({ databasePath: databasePaths[2], request });
await Promise.all(
  databasePaths.map((databasePath) => runVectorKnnInSubprocess({ databasePath, request })),
);
console.log("completed");
