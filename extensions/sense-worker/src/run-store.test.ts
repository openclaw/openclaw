import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatRunDate,
  formatRunId,
  readRunRecord,
  readRunRecordFromPath,
  resolveRunFilePath,
  writeRunRecord,
} from "./run-store.js";
import type { RunRecord } from "./run-types.js";

async function makeTempStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "sense-worker-run-store-"));
}

function sampleRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "run_20260414_143022_a3f",
    requested_by: "U123456789",
    requested_by_name: "taro",
    channel_id: "C0123456789",
    channel_name: "ops-general",
    raw_text: "health",
    kind: "health",
    normalized_task: "health",
    params: {},
    status: "queued",
    sense_job_id: null,
    queued_at: "2026-04-14T14:30:22.000Z",
    started_at: null,
    done_at: null,
    result: null,
    error: null,
    retry_of: null,
    retry_count: 0,
    slack_ts: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("run-store", () => {
  it("formats a run_id with the expected prefix", () => {
    const runId = formatRunId(new Date("2026-04-14T14:30:22.000Z"));
    expect(runId).toMatch(/^run_20260414_143022_[a-f0-9]{3}$/);
  });

  it("writes and reads a queued run record", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const record = sampleRecord();

    const writeResult = await writeRunRecord(record, env);
    expect(writeResult.path).toContain(path.join("runs", "2026-04-14", `${record.run_id}.json`));

    const loaded = await readRunRecord(
      {
        runId: record.run_id,
        queuedAt: record.queued_at,
      },
      env,
    );
    expect(loaded).toEqual(record);
  });

  it("resolves run paths under the queued date directory", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const filePath = resolveRunFilePath(
      {
        runId: "run_20260414_143022_a3f",
        queuedAt: "2026-04-14T14:30:22.000Z",
      },
      env,
    );
    expect(filePath).toBe(
      path.join(stateDir, "runs", "2026-04-14", "run_20260414_143022_a3f.json"),
    );
    expect(formatRunDate("2026-04-14T14:30:22.000Z")).toBe("2026-04-14");
  });

  it("returns null when reading a missing record path", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    const missing = await readRunRecordFromPath(path.join(stateDir, "runs", "missing.json"));
    expect(missing).toBeNull();
  });
});
