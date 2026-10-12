import { readFileSync, readdirSync } from "node:fs";

/** Identify the real host PID without treating a guest namespace PID as one. */
export function findLinuxProcessByArgv0(marker: string): number | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const argv0 = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")[0];
      if (argv0 === marker) {
        return Number(entry);
      }
    } catch {
      // A process can exit between enumeration and inspection.
    }
  }
  return undefined;
}
