import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { formatReliabilityStderr } from "./sqlite-reliability-contract.js";

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export function readReliabilitySidecarBytes(databasePath: string) {
  return {
    journalBytes: fileSize(`${databasePath}-journal`),
    walBytes: fileSize(`${databasePath}-wal`),
  };
}

export async function waitForReliabilitySidecars(params: {
  child: ChildProcess;
  databasePath: string;
  readStderr: () => string;
  ready: (bytes: ReturnType<typeof readReliabilitySidecarBytes>) => boolean;
  timeoutMs: number;
  exitMessage: string;
  timeoutMessage: string;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const observed = readReliabilitySidecarBytes(params.databasePath);
    if (params.ready(observed)) {
      return observed;
    }
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(`${params.exitMessage}${formatReliabilityStderr(params.readStderr())}`);
    }
    await delay(2);
  }
  throw new Error(params.timeoutMessage);
}
