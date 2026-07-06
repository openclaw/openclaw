// Real behavior proof: TranscriptsStore handles a real filesystem stream error
// gracefully instead of leaking an unhandled rejection.
//
// The proof creates a real transcript session directory where `transcript.jsonl`
// is a directory instead of a file. `fs.createReadStream` on a directory emits
// an EISDIR error on the stream. With the fix, `readUtterancesFromSessionDir`
// catches that error and returns the utterances parsed so far (none, in this
// case). Before the fix the unhandled stream error would reject the promise.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { TranscriptsStore } = await import(path.join(repoRoot, "src/transcripts/store.js"));

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-transcripts-"));

const session = {
  sessionId: "proof-session",
  startedAt: "2026-07-01T00:00:00Z",
};

const store = new TranscriptsStore(tmpDir);
const sessionDir = store.sessionDir(session);
await fs.mkdir(sessionDir, { recursive: true });

// Make transcript.jsonl a directory. createReadStream on a directory emits
// EISDIR, which exercises the stream error handler in readUtterancesFromDir.
const transcriptPath = path.join(sessionDir, "transcript.jsonl");
await fs.mkdir(transcriptPath);

console.log("=== Proof: transcripts store stream error catch ===\n");
console.log(`Created directory-as-file at: ${transcriptPath}`);
console.log("Calling readUtterancesFromSessionDir with maxUtterances...\n");

try {
  const result = await store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 10 });
  console.log(`Result: ${JSON.stringify(result)}`);
  if (Array.isArray(result) && result.length === 0) {
    console.log("\nPASS: EISDIR stream error was caught and returned an empty array.");
  } else {
    console.log("\nFAIL: unexpected result shape.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: readUtterancesFromSessionDir rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
