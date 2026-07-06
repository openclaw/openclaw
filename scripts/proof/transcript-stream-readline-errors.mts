// Real behavior proof: streamSessionTranscriptLines handles mid-stream read errors
// without crashing the caller's async iteration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { streamSessionTranscriptLines } = await import(
  path.join(repoRoot, "src/config/sessions/transcript-stream.js")
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-transcript-stream-"));
const transcriptPath = path.join(tmpDir, "session.jsonl");
fs.writeFileSync(transcriptPath, "one\ntwo\nthree\n", "utf-8");

// Force a mid-stream read error by truncating the file after the stream starts.
const originalCreateReadStream = fs.createReadStream;
fs.createReadStream = ((...args: unknown[]) => {
  const stream = originalCreateReadStream.apply(fs, args as never);
  setTimeout(() => {
    fs.truncateSync(args[0] as string, 0);
    stream.destroy(new Error("forced read error"));
  }, 10);
  return stream;
}) as typeof fs.createReadStream;

console.log("=== Proof: transcript stream mid-read error handling ===\n");

try {
  const lines: string[] = [];
  for await (const line of streamSessionTranscriptLines(transcriptPath)) {
    lines.push(line);
  }
  console.log(`PASS: streamSessionTranscriptLines completed without crashing (got ${lines.length} lines).`);
} catch (err) {
  console.error("FAIL: streamSessionTranscriptLines rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  fs.createReadStream = originalCreateReadStream;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
