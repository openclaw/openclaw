import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type SubagentLatestProgress = {
  phase: string;
  percentComplete?: number;
  updatedAt: string;
};

type ProgressLine = {
  phase?: unknown;
  percentComplete?: unknown;
  updatedAt?: unknown;
};

export function resolveProgressFilePath(runId: string, stateDir?: string): string {
  const root = stateDir?.trim() ? path.resolve(stateDir) : resolveStateDir(process.env);
  return path.join(root, "progress", `${runId}.jsonl`);
}

function normalizeLatestProgress(raw: ProgressLine): SubagentLatestProgress | undefined {
  const phase = typeof raw.phase === "string" ? raw.phase.trim() : "";
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt.trim() : "";
  if (!phase || !updatedAt) {
    return undefined;
  }

  const percentComplete =
    typeof raw.percentComplete === "number" &&
    Number.isFinite(raw.percentComplete) &&
    raw.percentComplete >= 0 &&
    raw.percentComplete <= 100
      ? raw.percentComplete
      : undefined;

  return {
    phase,
    updatedAt,
    ...(percentComplete !== undefined ? { percentComplete } : {}),
  };
}

export async function readLatestProgressForRun(params: {
  runId: string;
  stateDir?: string;
}): Promise<SubagentLatestProgress | undefined> {
  const runId = params.runId.trim();
  if (!runId) {
    return undefined;
  }
  const filePath = resolveProgressFilePath(runId, params.stateDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ProgressLine;
      const latest = normalizeLatestProgress(parsed);
      if (latest) {
        return latest;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

export async function cleanupProgressFileForRun(
  runId: string,
  opts?: { stateDir?: string },
): Promise<void> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return;
  }
  const filePath = resolveProgressFilePath(normalizedRunId, opts?.stateDir);
  await fs.rm(filePath, { force: true });
}
