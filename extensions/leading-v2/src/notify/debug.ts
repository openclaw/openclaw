import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Diagnostic trace file readable from the host while we confirm the notify
// pipeline end-to-end. Fire-and-forget; never throws into callers.
const DEBUG_FILE = join(homedir(), ".openclaw", "leading-v2-notify-debug.log");

export function debugLog(line: string): void {
  // Never write to the host's home dir from tests.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  const ts = new Date().toISOString();
  void appendFile(DEBUG_FILE, `${ts} ${line}\n`).catch(() => {});
}
