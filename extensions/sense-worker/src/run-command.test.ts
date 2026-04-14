import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCommandContext } from "../../../src/plugins/types.js";
import { buildQueuedRunRecord, handleRunCommand } from "./run-command.js";
import { readRunRecordFromPath } from "./run-store.js";

async function makeTempStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "sense-worker-run-command-"));
}

function makeContext(args?: string): PluginCommandContext {
  return {
    senderId: "U123456789",
    channel: "slack",
    channelId: "C0123456789",
    isAuthorizedSender: true,
    args,
    commandBody: args ? `run ${args}` : "run",
    config: {},
    from: "taro",
    messageThreadId: undefined,
    to: "C0123456789",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "error", message: "unused" })),
    detachConversationBinding: vi.fn(async () => ({ removed: false })),
    getCurrentConversationBinding: vi.fn(async () => null),
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

describe("run-command", () => {
  it("returns help text when args are empty", async () => {
    const result = await handleRunCommand(makeContext(undefined));
    expect(result.text).toContain("OpenClaw run commands");
    expect(result.text).toContain("/openclaw run health");
  });

  it("builds a queued health run record", () => {
    const built = buildQueuedRunRecord({
      args: "health",
      ctx: makeContext("health"),
      now: new Date("2026-04-14T14:30:22.000Z"),
      runId: "run_20260414_143022_a3f",
    });
    expect(built).toMatchObject({
      kind: "queued",
      record: {
        run_id: "run_20260414_143022_a3f",
        kind: "health",
        normalized_task: "health",
        status: "queued",
        requested_by: "U123456789",
        requested_by_name: "taro",
        channel_id: "C0123456789",
      },
    });
  });

  it("queues and persists a digest run record", async () => {
    const stateDir = await makeTempStateDir();
    tempDirs.push(stateDir);
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const now = new Date("2026-04-14T14:30:22.000Z");
      const result = await handleRunCommand(makeContext("digest"), {
        now: () => now,
        executeRun: vi.fn(async () => sampleQueuedExecutionResult()),
      });
      expect(result.text).toContain("受付しました");
      expect(result.text).toContain("タスク: `digest`");

      const [fileName] = await fs.readdir(path.join(stateDir, "runs", "2026-04-14"));
      const saved = await readRunRecordFromPath(
        path.join(stateDir, "runs", "2026-04-14", fileName),
      );
      expect(saved).toMatchObject({
        kind: "digest",
        normalized_task: "digest",
        status: "queued",
      });
    } finally {
      if (oldStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = oldStateDir;
      }
    }
  });

  it("starts execution in the background after queueing", async () => {
    const executeRun = vi.fn(async () => sampleQueuedExecutionResult());
    const result = await handleRunCommand(makeContext("health"), {
      writeRecord: vi.fn(async () => ({ path: "/tmp/run.json" })),
      executeRun,
    });
    expect(result.text).toContain("受付しました");
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(executeRun.mock.calls[0]?.[0]).toMatchObject({
      status: "queued",
      kind: "health",
    });
  });
  it("queues free-text work as kind=free", () => {
    const built = buildQueuedRunRecord({
      args: "NAS backup status を確認して",
      ctx: makeContext("NAS backup status を確認して"),
      now: new Date("2026-04-14T14:30:22.000Z"),
      runId: "run_20260414_143022_a3f",
    });
    expect(built).toMatchObject({
      kind: "queued",
      record: {
        kind: "free",
        raw_text: "NAS backup status を確認して",
        normalized_task: "NAS backup status を確認して",
      },
    });
  });

  it("uses only ctx.to for channel_id and falls back to null", () => {
    const built = buildQueuedRunRecord({
      args: "health",
      ctx: {
        senderId: "U123456789",
        channelId: undefined,
        from: "taro",
        messageThreadId: undefined,
        to: "   ",
      },
      now: new Date("2026-04-14T14:30:22.000Z"),
      runId: "run_20260414_143022_a3f",
    });
    expect(built).toMatchObject({
      kind: "queued",
      record: {
        channel_id: null,
      },
    });
  });

  it("prefers plugin command channelId over ctx.to for channel_id", () => {
    const built = buildQueuedRunRecord({
      args: "health",
      ctx: {
        senderId: "U123456789",
        channelId: "C9999999999",
        from: "taro",
        messageThreadId: undefined,
        to: "slash:U123456789",
      },
      now: new Date("2026-04-14T14:30:22.000Z"),
      runId: "run_20260414_143022_a3f",
    });
    expect(built).toMatchObject({
      kind: "queued",
      record: {
        channel_id: "C9999999999",
      },
    });
  });

  it("stores slack_ts from messageThreadId when available", () => {
    const built = buildQueuedRunRecord({
      args: "health",
      ctx: {
        senderId: "U123456789",
        channelId: "C0123456789",
        from: "taro",
        to: "C0123456789",
        messageThreadId: "1712345678.123456",
      },
      now: new Date("2026-04-14T14:30:22.000Z"),
      runId: "run_20260414_143022_a3f",
    });
    expect(built).toMatchObject({
      kind: "queued",
      record: {
        slack_ts: "1712345678.123456",
      },
    });
  });

  it("rejects multiline input", async () => {
    const result = await handleRunCommand(makeContext("line1\nline2"));
    expect(result.text).toBe("入力が無効です: 改行は使えません");
  });

  it("rejects future subcommands that are not implemented yet", async () => {
    const result = await handleRunCommand(makeContext("job run_20260414_143022_a3f"));
    expect(result.text).toContain("まだ未実装です");
  });
});

function sampleQueuedExecutionResult() {
  return {
    run_id: "run_20260414_143022_a3f",
    requested_by: "U123456789",
    requested_by_name: "taro",
    channel_id: "C0123456789",
    channel_name: null,
    raw_text: "health",
    kind: "health" as const,
    normalized_task: "health",
    params: {},
    status: "running" as const,
    sense_job_id: null,
    queued_at: "2026-04-14T14:30:22.000Z",
    started_at: "2026-04-14T14:30:24.000Z",
    done_at: null,
    result: null,
    error: null,
    retry_of: null,
    retry_count: 0,
    slack_ts: null,
  };
}
