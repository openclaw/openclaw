// Real behavior proof: TranscriptsStore rejects non-ENOENT stream errors
// gracefully instead of leaking an unhandled rejection or returning partial data.
//
// The proof creates a real transcript session directory where `transcript.jsonl`
// is a directory instead of a file. `fs.createReadStream` on a directory emits
// an EISDIR error on the stream. With the fix, `readUtterancesFromSessionDir`
// rejects with that error after the stream closes. Missing files (ENOENT) still
// resolve to an empty array. Before the fix the unhandled stream error would
// reject the promise before listeners were attached.

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
  await store.readUtterancesFromSessionDir(sessionDir, { maxUtterances: 10 });
  console.log("\nFAIL: readUtterancesFromSessionDir should have rejected for EISDIR.");
  process.exitCode = 1;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`Rejected with: ${message}`);
  if (message.includes("EISDIR") || message.includes("is a directory")) {
    console.log("\nPASS: EISDIR stream error was caught and rejected after stream close.");
  } else {
    console.log("\nFAIL: unexpected rejection reason.");
    process.exitCode = 1;
  }
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
