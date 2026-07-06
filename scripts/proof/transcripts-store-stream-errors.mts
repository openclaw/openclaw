// Real behavior proof: `TranscriptsStore.readUtterancesFromDir` handles
// readline/file stream errors gracefully instead of crashing.
//
// The regression test mocks `createReadStream` to emit an `error` event after
// a valid transcript line and verifies that the store returns the utterances
// parsed so far. Before the fix the unhandled stream error would reject.

import { spawnSync } from "node:child_process";

console.log("=== Proof: transcripts store stream error catch ===\n");
console.log("Running regression test suite: src/transcripts/store.test.ts\n");

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/transcripts/store.test.ts"],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0 && result.error === undefined) {
  console.log("\nPASS: transcript store stream errors return parsed utterances.");
} else {
  console.log("\nFAIL: regression test suite did not pass.");
  process.exitCode = 1;
}
