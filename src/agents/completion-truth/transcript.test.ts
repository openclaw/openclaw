import { describe, expect, it } from "vitest";
import { normalizeSessionsHistoryMessages, selectTranscriptResult } from "./transcript.js";

describe("transcript completion selection", () => {
  it("normalizes structured sessions-history-like tool records", () => {
    const records = normalizeSessionsHistoryMessages([
      {
        role: "tool",
        name: "sessions_yield",
        result: {
          source: "sessions_yield",
          status: "yielded",
          worker_id: "done",
        },
        created_at: "2026-04-25T00:00:00.000Z",
      },
    ]);

    expect(records).toEqual([
      {
        role: "tool",
        toolName: "sessions_yield",
        toolResult: {
          source: "sessions_yield",
          status: "yielded",
          worker_id: "done",
        },
        createdAt: "2026-04-25T00:00:00.000Z",
      },
    ]);
    expect(selectTranscriptResult(records)).toEqual({
      source: "sessions_yield",
      status: "yielded",
      worker_id: "done",
    });
  });

  it("selects the newest explicit completion tool record", () => {
    expect(
      selectTranscriptResult([
        {
          role: "tool",
          toolName: "sessions_yield",
          toolResult: {
            source: "sessions_yield",
            status: "yielded",
            worker_id: "old",
          },
        },
        {
          role: "tool",
          toolName: "worker_completion",
          toolResult: {
            source: "worker_completion",
            status: "done",
            worker_id: "new",
          },
        },
      ]),
    ).toEqual({
      source: "worker_completion",
      status: "done",
      worker_id: "new",
    });
  });

  it("does not parse assistant prose as tool result", () => {
    const records = normalizeSessionsHistoryMessages([
      { role: "assistant", content: '{"worker_id":"fake"}' },
    ]);
    expect(selectTranscriptResult(records)).toBeUndefined();
  });

  it("fails explicitly for malformed completion tool records", () => {
    expect(() =>
      selectTranscriptResult([{ role: "tool", toolName: "sessions_yield", toolResult: "bad" }]),
    ).toThrow(/Invalid transcript completion record/);
  });

  it("rejects object completion records without required envelope fields", () => {
    expect(() =>
      selectTranscriptResult([
        {
          role: "tool",
          toolName: "sessions_yield",
          toolResult: { worker_id: "loose" },
        },
      ]),
    ).toThrow(/Invalid transcript completion record/);
  });
});
