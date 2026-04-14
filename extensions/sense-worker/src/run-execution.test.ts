import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSenseManagerTaskInvocation, executeQueuedRun } from "./run-execution.js";
import { readRunRecordFromPath, writeRunRecord } from "./run-store.js";
import type { RunRecord } from "./run-types.js";

async function makeTempStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "sense-worker-run-execution-"));
}

function sampleQueuedRun(overrides: Partial<RunRecord> = {}): RunRecord {
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("run-execution", () => {
  it("builds digest bridge invocation with probe params", () => {
    const invocation = buildSenseManagerTaskInvocation(
      sampleQueuedRun({ kind: "digest", raw_text: "digest" }),
      {
        baseUrl: "http://sense.local:8787",
        tokenEnv: "CUSTOM_TOKEN",
        timeoutSec: 15,
        waitTimeoutSec: 45,
        pollIntervalSec: 3,
      },
    );
    expect(invocation.command).toBe("python3");
    expect(invocation.args).toContain("--task");
    expect(invocation.args).toContain("digest");
    expect(invocation.args).toContain("--base-url");
    expect(invocation.args).toContain("http://sense.local:8787");
    expect(invocation.args).toContain("--token-env");
    expect(invocation.args).toContain("CUSTOM_TOKEN");
    const paramsJson = invocation.args[invocation.args.indexOf("--params-json") + 1];
    expect(JSON.parse(paramsJson)).toMatchObject({
      mode: "digest_ready_probe",
      digest_ready_probe: true,
      task_type: "digest",
    });
  });

  it("updates a queued run to done after a successful bridge call", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const record = sampleQueuedRun();
    await writeRunRecord(record);

    const nowMock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-04-14T14:30:24.000Z"))
      .mockReturnValueOnce(new Date("2026-04-14T14:31:05.000Z"));

    const completed = await executeQueuedRun(record, {
      now: nowMock,
      notify: vi.fn(async () => ({ delivered: true as const, text: "sent" })),
      runBridge: vi.fn(async () => ({
        payload: {
          sense_job_id: "job_abc123def456",
          summary: "All systems nominal. GPU: OK, Ollama: OK",
          key_points: ["GPU load 12%", "Ollama responding", "No queued failures"],
          suggested_next_action: null,
          exit_code: 0,
          raw_output: "ok",
        },
        stdout: '{"summary":"ok"}',
        stderr: "",
        exitCode: 0,
      })),
    });

    expect(completed).toMatchObject({
      status: "done",
      sense_job_id: "job_abc123def456",
      started_at: "2026-04-14T14:30:24.000Z",
      done_at: "2026-04-14T14:31:05.000Z",
      result: {
        exit_code: 0,
      },
      error: null,
    });

    const persisted = await readRunRecordFromPath(
      path.join(stateDir, "runs", "2026-04-14", `${record.run_id}.json`),
    );
    expect(persisted).toMatchObject({
      status: "done",
      sense_job_id: "job_abc123def456",
      started_at: "2026-04-14T14:30:24.000Z",
      done_at: "2026-04-14T14:31:05.000Z",
    });
  });

  it("updates a queued run to failed when the bridge returns a non-zero exit", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const record = sampleQueuedRun({ kind: "free", raw_text: "NAS backup status を確認して" });
    await writeRunRecord(record);

    const completed = await executeQueuedRun(record, {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-04-14T14:30:24.000Z"))
        .mockReturnValueOnce(new Date("2026-04-14T14:31:05.000Z")),
      notify: vi.fn(async () => ({ delivered: true as const, text: "sent" })),
      runBridge: vi.fn(async () => ({
        payload: {
          sense_job_id: "job_failed_case",
          summary: "Bridge failed",
          key_points: [],
          suggested_next_action: "Retry later",
          exit_code: 1,
          raw_output: "trace",
          error: "Sense worker 接続タイムアウト",
        },
        stdout: '{"summary":"Bridge failed"}',
        stderr: "timeout",
        exitCode: 1,
      })),
    });

    expect(completed).toMatchObject({
      status: "failed",
      sense_job_id: "job_failed_case",
      result: {
        exit_code: 1,
      },
      error: {
        message: "Sense worker 接続タイムアウト",
      },
    });
  });

  it("marks the run as failed when the bridge throws", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const record = sampleQueuedRun();
    await writeRunRecord(record);

    const completed = await executeQueuedRun(record, {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-04-14T14:30:24.000Z"))
        .mockReturnValueOnce(new Date("2026-04-14T14:31:05.000Z")),
      notify: vi.fn(async () => ({ delivered: true as const, text: "sent" })),
      runBridge: vi.fn(async () => {
        throw new Error("request failed: Connection refused");
      }),
    });

    expect(completed).toMatchObject({
      status: "failed",
      started_at: "2026-04-14T14:30:24.000Z",
      done_at: "2026-04-14T14:31:05.000Z",
      error: {
        message: "request failed: Connection refused",
      },
    });
  });

  it("notifies after writing the completed run", async () => {
    const writeEvents: string[] = [];
    const notify = vi.fn(async () => ({ delivered: true as const, text: "sent" }));
    await executeQueuedRun(sampleQueuedRun({ slack_ts: "1712345678.123456" }), {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-04-14T14:30:24.000Z"))
        .mockReturnValueOnce(new Date("2026-04-14T14:31:05.000Z")),
      writeRecord: vi.fn(async (run) => {
        writeEvents.push(run.status);
        return { path: "/tmp/run.json" };
      }),
      notify,
      runBridge: vi.fn(async () => ({
        payload: {
          sense_job_id: "job_abc123def456",
          summary: "ok",
          key_points: [],
          suggested_next_action: null,
          exit_code: 0,
          raw_output: "ok",
        },
        stdout: '{"summary":"ok"}',
        stderr: "",
        exitCode: 0,
      })),
    });

    expect(writeEvents).toEqual(["running", "done"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      record: {
        status: "done",
        slack_ts: "1712345678.123456",
      },
    });
  });

  it("keeps failed status when notification throws", async () => {
    const completed = await executeQueuedRun(sampleQueuedRun({ slack_ts: "1712345678.123456" }), {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-04-14T14:30:24.000Z"))
        .mockReturnValueOnce(new Date("2026-04-14T14:31:05.000Z")),
      notify: vi.fn(async () => {
        throw new Error("slack unavailable");
      }),
      runBridge: vi.fn(async () => ({
        payload: {
          sense_job_id: "job_failed_case",
          summary: "Bridge failed",
          key_points: [],
          suggested_next_action: null,
          exit_code: 1,
          raw_output: "trace",
          error: "Sense worker 接続タイムアウト",
        },
        stdout: '{"summary":"Bridge failed"}',
        stderr: "timeout",
        exitCode: 1,
      })),
    });

    expect(completed).toMatchObject({
      status: "failed",
      error: {
        message: "Sense worker 接続タイムアウト",
      },
    });
  });
});
