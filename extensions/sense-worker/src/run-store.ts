import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../src/config/paths.js";
import type { RunRecord } from "./run-types.js";

const RUN_ID_RE = /^run_[A-Za-z0-9_]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function formatRunDate(queuedAt: string): string {
  return queuedAt.slice(0, 10);
}

export function formatRunId(date: Date = new Date()): string {
  const iso = date.toISOString();
  const yyyymmdd = iso.slice(0, 10).replaceAll("-", "");
  const hhmmss = iso.slice(11, 19).replaceAll(":", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 3);
  return `run_${yyyymmdd}_${hhmmss}_${suffix}`;
}

export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

export function resolveRunsRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "runs");
}

export function resolveRunFilePath(
  params: {
    runId: string;
    queuedAt: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isValidRunId(params.runId)) {
    throw new Error(`Invalid run_id: ${params.runId}`);
  }
  const day = formatRunDate(params.queuedAt);
  return path.join(resolveRunsRootDir(env), day, `${params.runId}.json`);
}

export async function writeRunRecord(
  record: RunRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string }> {
  const filePath = resolveRunFilePath(
    {
      runId: record.run_id,
      queuedAt: record.queued_at,
    },
    env,
  );
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, filePath);
  return { path: filePath };
}

export async function readRunRecord(
  params: {
    runId: string;
    queuedAt: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunRecord | null> {
  const filePath = resolveRunFilePath(params, env);
  return readRunRecordFromPath(filePath);
}

export async function readRunRecordFromPath(filePath: string): Promise<RunRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record || typeof record.run_id !== "string" || !isValidRunId(record.run_id)) {
      return null;
    }
    return parsed as RunRecord;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
