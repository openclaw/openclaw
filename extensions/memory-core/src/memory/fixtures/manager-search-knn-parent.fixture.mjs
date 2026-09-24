import { mock } from "node:test";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { runVectorKnnInSubprocess } from "../manager-search-knn-subprocess.ts";

const { databasePaths, request, expireIdle } = JSON.parse(process.argv[2]);
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
