import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerLogTransport, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { logModelFallbackDecision } from "./model-fallback-observation.js";

describe("logModelFallbackDecision", () => {
  afterEach(() => {
    setLoggerOverride(null);
    resetLogger();
  });

  it("sanitizes current and previous error text fields", () => {
    const records: Array<Record<string, unknown>> = [];
    setLoggerOverride({
      level: "trace",
      consoleLevel: "silent",
      file: path.join(os.tmpdir(), `openclaw-model-fallback-${Date.now()}.log`),
    });
    const unregister = registerLogTransport((record) => {
      records.push(record);
    });

    logModelFallbackDecision({
      decision: "candidate_failed",
      runId: "run:model-fallback",
      requestedProvider: "openai",
      requestedModel: "gpt-5",
      candidate: { provider: "openai", model: "gpt-5" },
      reason: "overloaded",
      error:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_current"}',
      previousAttempts: [
        {
          provider: "anthropic",
          model: "claude-sonnet",
          reason: "overloaded",
          error:
            '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded earlier"},"request_id":"req_previous"}',
        },
      ],
    });

    unregister();

    expect(records).toHaveLength(1);
    expect(records[0]?.["1"]).toMatchObject({
      event: "model_fallback_decision",
      runId: "run:model-fallback",
      errorPreview: expect.stringContaining('"request_id":"sha256:'),
      errorHash: expect.stringMatching(/^sha256:/),
      errorFingerprint: expect.stringMatching(/^sha256:/),
      requestIdHash: expect.stringMatching(/^sha256:/),
      previousAttempts: [
        expect.objectContaining({
          textPreview: expect.stringContaining('"request_id":"sha256:'),
          textHash: expect.stringMatching(/^sha256:/),
          textFingerprint: expect.stringMatching(/^sha256:/),
          requestIdHash: expect.stringMatching(/^sha256:/),
        }),
      ],
    });

    const meta = records[0]?.["1"] as Record<string, unknown>;
    expect(String(meta.errorPreview)).not.toContain("req_current");
    expect(JSON.stringify(meta.previousAttempts)).not.toContain("req_previous");
  });
});
