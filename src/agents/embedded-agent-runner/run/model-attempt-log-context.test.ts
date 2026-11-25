import { describe, expect, it } from "vitest";
import {
  modelAttemptLogContext,
  retryModelAttemptLogContext,
} from "./model-attempt-log-context.js";

const attempt = {
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  modelCallSequence: { value: 7 },
};

describe("model attempt log identity", () => {
  it("uses the dispatched attempt and advances its provider retry", () => {
    expect(modelAttemptLogContext(attempt)).toBe(
      "runId=run-1 sessionId=session-1 sessionKey=agent:main:session-1 attemptId=run-1:model:7",
    );
    expect(retryModelAttemptLogContext(attempt)).toContain("retryAttemptId=run-1:model:8");
  });

  it("targets and retries the same unconsumed call for initial preflight recovery", () => {
    const recovery = { route: "compact_only" as const };
    expect(modelAttemptLogContext(attempt, recovery)).toContain("attemptId=run-1:model:8");
    expect(retryModelAttemptLogContext(attempt, recovery)).toContain(
      "retryAttemptId=run-1:model:8",
    );
  });

  it("uses the current call and the next call for mid-turn recovery", () => {
    const recovery = { route: "compact_only" as const, source: "mid-turn" as const };
    expect(modelAttemptLogContext(attempt, recovery)).toContain("attemptId=run-1:model:7");
    expect(retryModelAttemptLogContext(attempt, recovery)).toContain(
      "retryAttemptId=run-1:model:8",
    );
  });

  it("matches model:1 before the first dispatched call", () => {
    expect(modelAttemptLogContext({ ...attempt, modelCallSequence: { value: 0 } })).toContain(
      "attemptId=run-1:model:1",
    );
    expect(modelAttemptLogContext({ ...attempt, modelCallSequence: undefined })).toContain(
      "attemptId=run-1:model:1",
    );
  });
});
