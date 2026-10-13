import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isPidDefinitelyDead } from "openclaw/plugin-sdk/process-runtime";
import { inspectLinuxProcessGroupStats } from "./posix-process-stat.js";

type QaLinuxProcessGroupInspection = ReturnType<typeof inspectLinuxProcessGroupStats>;
export type QaLinuxProcessGroupInspector = (
  processGroupId: number,
) => QaLinuxProcessGroupInspection | null;

export function inspectLinuxProcessGroup(
  processGroupId: number,
): QaLinuxProcessGroupInspection | null {
  if (process.platform !== "linux") {
    return null;
  }
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  const stats: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    try {
      stats.push(readFileSync(path.join("/proc", entry.name, "stat"), "utf8"));
    } catch (error) {
      // Exit can race either opening stat (ENOENT) or reading its open fd (ESRCH).
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return null;
      }
    }
  }
  return inspectLinuxProcessGroupStats(processGroupId, stats, isPidDefinitelyDead);
}

export function isQaPosixProcessGroupAlive(
  processGroupId: number,
  inspectLinuxProcessGroupFn: QaLinuxProcessGroupInspector = inspectLinuxProcessGroup,
) {
  try {
    process.kill(-processGroupId, 0);
    // Inconclusive snapshots stay alive until the next shutdown check.
    return (
      process.platform !== "linux" || (inspectLinuxProcessGroupFn(processGroupId)?.alive ?? true)
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function signalQaPosixProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): Error | undefined {
  try {
    process.kill(-processGroupId, signal);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return undefined;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
