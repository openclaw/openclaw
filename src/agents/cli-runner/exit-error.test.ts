import { describe, expect, it } from "vitest";
import { FailoverError } from "../failover-error.js";
import { createCliExitFailoverError, resolveCliResumeAtError } from "./exit-error.js";

const context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane"> = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  sessionId: "session-1",
  lane: "run",
};

// Production wiring: the Anthropic backend's resumeAtArg is the option name
// (--resume-session-at), while the checkpoint uuid travels as the value the run
// actually sent. Claude Code names that uuid when the transcript lost it.
const RESUME_AT_ARG = "--resume-session-at";
const CHECKPOINT_UUID = "11111111-2222-3333-4444-555555555555";

function classifyExit(
  candidates: readonly string[],
  resume: { resumeAtArg?: string; resumeCheckpointId?: string },
) {
  return createCliExitFailoverError({
    context,
    candidates,
    retryEmptyFailure: false,
    fallbackMessage: "CLI failed.",
    ...resume,
  });
}

describe("createCliExitFailoverError resume rejection", () => {
  it("classifies Claude Code's missing-checkpoint rejection as an expired session", () => {
    const error = classifyExit([`No message found with message.uuid of: ${CHECKPOINT_UUID}`], {
      resumeAtArg: RESUME_AT_ARG,
      resumeCheckpointId: CHECKPOINT_UUID,
    });
    expect(error.reason).toBe("session_expired");
    expect(error.code).toBe("cli_resume_at_unsupported");
  });

  it("reads the rejected checkpoint out of the structured result record", () => {
    const record = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [`No message found with message.uuid of: ${CHECKPOINT_UUID}`],
    });
    const error = classifyExit([record], {
      resumeAtArg: RESUME_AT_ARG,
      resumeCheckpointId: CHECKPOINT_UUID,
    });
    expect(error.reason).toBe("session_expired");
    expect(error.code).toBe("cli_resume_at_unsupported");
  });

  it("keeps classifying an unsupported resume option as an expired session", () => {
    const error = classifyExit(["error: unknown option '--resume-session-at'"], {
      resumeAtArg: RESUME_AT_ARG,
    });
    expect(error.reason).toBe("session_expired");
    expect(error.code).toBe("cli_resume_at_unsupported");
  });

  it("ignores a missing-checkpoint message that names a different checkpoint", () => {
    const error = classifyExit(
      ["No message found with message.uuid of: 99999999-8888-7777-6666-555555555555"],
      { resumeAtArg: RESUME_AT_ARG, resumeCheckpointId: CHECKPOINT_UUID },
    );
    expect(error.reason).toBe("unknown");
  });

  it("keeps unrelated unknown failures untouched", () => {
    const error = classifyExit(["something else went wrong"], {
      resumeAtArg: RESUME_AT_ARG,
      resumeCheckpointId: CHECKPOINT_UUID,
    });
    expect(error.reason).toBe("unknown");
  });
});

it("does not reinterpret aborts or already-classified timeouts as checkpoint rejection", () => {
  const message = "No message found with message.uuid of: " + CHECKPOINT_UUID;
  const abort = new Error(message);
  abort.name = "AbortError";
  const timeout = new FailoverError(message, { reason: "timeout", ...context });
  for (const error of [abort, timeout]) {
    expect(
      resolveCliResumeAtError(error, { resumeCheckpointId: CHECKPOINT_UUID }, context),
    ).toBeUndefined();
  }
});

it("does not classify a UUID mention without the checkpoint diagnostic", () => {
  expect(
    classifyExit(["Unrelated failure for " + CHECKPOINT_UUID], {
      resumeCheckpointId: CHECKPOINT_UUID,
    }).reason,
  ).toBe("unknown");
});
