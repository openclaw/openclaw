import { describe, expect, it } from "vitest";
import { resolveModelRequestContext } from "./request-context.js";

describe("resolveModelRequestContext", () => {
  it("captures run id, normalized message channel, and message operation", () => {
    expect(
      resolveModelRequestContext({
        runId: " run-123 ",
        messageChannel: "Telegram",
        bootstrapContextRunKind: "default",
      }),
    ).toEqual({
      runId: "run-123",
      messageChannel: "telegram",
      operation: "message",
    });
  });

  it("classifies heartbeat and scheduled runs separately from user messages", () => {
    expect(
      resolveModelRequestContext({
        runId: "run-heartbeat",
        messageProvider: "slack",
        bootstrapContextRunKind: "heartbeat",
      }),
    ).toEqual({
      runId: "run-heartbeat",
      messageChannel: "slack",
      operation: "heartbeat",
    });

    expect(
      resolveModelRequestContext({
        runId: "run-cron",
        bootstrapContextRunKind: "cron",
      }),
    ).toEqual({
      runId: "run-cron",
      operation: "scheduled_job",
    });
  });

  it("marks non-channel default runs as manual operations", () => {
    expect(resolveModelRequestContext({ runId: "run-manual" })).toEqual({
      runId: "run-manual",
      operation: "manual",
    });
  });
});
