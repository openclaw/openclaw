import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedIsFailoverAssistantError,
  mockedLog,
  mockedMarkAuthProfileGood,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function makeOverloadedAssistant(): EmbeddedRunAttemptResult["lastAssistant"] {
  return {
    stopReason: "error",
    errorMessage:
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"}}',
  } as EmbeddedRunAttemptResult["lastAssistant"];
}

function makeSuccessfulAssistant(): EmbeddedRunAttemptResult["lastAssistant"] {
  return {
    stopReason: "end_turn",
    usage: {
      input: 100,
      cacheRead: 200,
      cacheWrite: 0,
      total: 300,
    },
  } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
}

describe("same-profile overloaded retry loop", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
    mockedClassifyFailoverReason.mockReset();
    mockedClassifyFailoverReason.mockImplementation((message?: string) =>
      String(message ?? "").includes("overloaded_error") ? "overloaded" : null,
    );
    mockedIsFailoverAssistantError.mockReset();
    mockedIsFailoverAssistantError.mockImplementation((assistant?: { errorMessage?: string }) =>
      String(assistant?.errorMessage ?? "").includes("overloaded_error"),
    );
    mockedMarkAuthProfileGood.mockReset();
    mockedMarkAuthProfileGood.mockResolvedValue(undefined);
    mockedLog.warn.mockReset();
    mockedLog.info.mockReset();
    mockedLog.debug.mockReset();
    mockedLog.error.mockReset();
  });

  it("retries twice on overloaded assistant errors and succeeds on the third attempt", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: makeOverloadedAssistant(),
          assistantTexts: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: makeOverloadedAssistant(),
          assistantTexts: [],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: makeSuccessfulAssistant(),
          assistantTexts: ["ok"],
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(mockedMarkAuthProfileGood).toHaveBeenCalledTimes(3);
    expect(
      mockedLog.warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" &&
          message.includes("retrying same profile for anthropic/test-model"),
      ),
    ).toHaveLength(2);
    expect(result.meta.error).toBeUndefined();
  });
});
