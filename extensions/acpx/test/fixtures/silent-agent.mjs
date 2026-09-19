#!/usr/bin/env node
// Synthetic non-ACP peer: like `codex exec`, it consumes stdin waiting for a prompt and never
// answers `initialize`. With --ignore-term it also survives SIGTERM, forcing SIGKILL escalation.
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {});
}
process.stderr.write("Reading prompt from stdin...\n");
process.stdin.resume();
setInterval(() => {}, 60_000);
