import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStreamEventOrderError } from "../pi-embedded-helpers.js";
import { log } from "./logger.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.shared-test.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const mockedIsStreamEventOrderError = vi.mocked(isStreamEventOrderError);

describe("stream event order error retry in run loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsStreamEventOrderError.mockImplementation((msg: string) =>
      /unexpected event order/i.test(msg),
    );
  });

  it("retries once on stream event order error and succeeds", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: {
            stopReason: "error",
            errorMessage:
              'Unexpected event order, got message_start before receiving "message_stop"',
          } as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("stream event order error (attempt 1/2)"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries up to MAX_STREAM_EVENT_ORDER_RETRIES then stops", async () => {
    const streamOrderError = {
      stopReason: "error",
      errorMessage: 'Unexpected event order, got message_start before receiving "message_stop"',
    } as EmbeddedRunAttemptResult["lastAssistant"];

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({ promptError: null, lastAssistant: streamOrderError }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({ promptError: null, lastAssistant: streamOrderError }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({ promptError: null, lastAssistant: streamOrderError }),
      );

    await runEmbeddedPiAgent(baseParams);

    // 3 attempts: initial + 2 retries (MAX=2), third one is not retried
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("stream event order error (attempt 1/2)"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("stream event order error (attempt 2/2)"),
    );
  });

  it("does not retry when the error is not a stream event order error", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        lastAssistant: {
          stopReason: "error",
          errorMessage: "Some other LLM error",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("stream event order error"));
  });

  it("does not retry when aborted", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        aborted: true,
        promptError: null,
        lastAssistant: {
          stopReason: "error",
          errorMessage: 'Unexpected event order, got message_start before receiving "message_stop"',
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("stream event order error"));
  });
});
