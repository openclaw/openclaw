import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "./run-types.js";

const sendMessageSlackMock = vi.fn();

vi.mock("../../slack/src/send.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
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
    status: "done",
    sense_job_id: "job_abc123def456",
    queued_at: "2026-04-14T14:30:22.000Z",
    started_at: "2026-04-14T14:30:24.000Z",
    done_at: "2026-04-14T14:31:05.000Z",
    result: {
      summary: "All systems nominal. GPU: OK, Ollama: OK",
      key_points: ["GPU load 12%", "Ollama responding", "No queued failures"],
      suggested_next_action: null,
      exit_code: 0,
      raw_output: "ok",
    },
    error: null,
    retry_of: null,
    retry_count: 0,
    slack_ts: "1712345678.123456",
    ...overrides,
  };
}

describe("run notify", () => {
  it("formats done notification with summary, key points, and office url", async () => {
    vi.stubEnv("OPENCLAW_OFFICE_URL", "http://127.0.0.1:19000/");
    sendMessageSlackMock.mockResolvedValue({
      messageId: "1712345678.123457",
      channelId: "C0123456789",
    });
    const { buildRunNotificationText, notifyRunCompletion } = await import("./run-notify.js");

    const record = sampleRun();
    const text = buildRunNotificationText(record);
    expect(text).toContain(":white_check_mark: 完了 - run_20260414_143022_a3f");
    expect(text).toContain("タスク: health | 実行時間: 41秒");
    expect(text).toContain("> All systems nominal. GPU: OK, Ollama: OK");
    expect(text).toContain("- GPU load 12%");
    expect(text).toContain("詳細: http://127.0.0.1:19000/runs/run_20260414_143022_a3f");

    const result = await notifyRunCompletion({ record });
    expect(result).toMatchObject({ delivered: true });
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C0123456789",
      expect.stringContaining("完了"),
      expect.objectContaining({ threadTs: "1712345678.123456" }),
    );
  });

  it("formats failed notification with the error message", async () => {
    const { buildRunNotificationText } = await import("./run-notify.js");
    const text = buildRunNotificationText(
      sampleRun({
        status: "failed",
        result: {
          summary: "Bridge failed",
          key_points: [],
          suggested_next_action: null,
          exit_code: 1,
          raw_output: "trace",
        },
        error: {
          message: "Sense worker 接続タイムアウト",
        },
      }),
    );
    expect(text).toContain(":x: 失敗 - run_20260414_143022_a3f");
    expect(text).toContain("エラー: Sense worker 接続タイムアウト");
  });

  it("skips notification when channel_id is missing", async () => {
    const { notifyRunCompletion } = await import("./run-notify.js");
    const result = await notifyRunCompletion({
      record: sampleRun({ channel_id: null }),
    });
    expect(result).toEqual({ delivered: false, skipped: "missing_channel_id" });
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
  });

  it("posts to the channel when slack_ts is missing", async () => {
    sendMessageSlackMock.mockResolvedValue({
      messageId: "1712345678.123457",
      channelId: "C0123456789",
    });
    const { notifyRunCompletion } = await import("./run-notify.js");
    const result = await notifyRunCompletion({
      record: sampleRun({ slack_ts: null }),
    });
    expect(result).toMatchObject({ delivered: true });
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C0123456789",
      expect.any(String),
      expect.not.objectContaining({ threadTs: expect.anything() }),
    );
  });
});
