// Coverage for preserving channel-aware silent-reply policy through embedded attempts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent silent-reply prompt mode", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("forwards channel-aware suppression to the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-silent-reply-prompt-mode",
      silentReplyPromptMode: "none",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ silentReplyPromptMode: "none" }),
    );
  });
});
