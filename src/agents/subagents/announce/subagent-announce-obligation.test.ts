import { describe, expect, it } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { resolveFailedAnnounceResponse } from "./subagent-announce-obligation.js";

// A completion that owes the user a visible final from its parent turn.
const owedFinal = {
  params: {
    requesterSessionKey: "agent:main:discord:dm:U123",
    targetRequesterSessionKey: "agent:main:discord:dm:U123",
    triggerMessage: "A background task completed.",
    expectsCompletionMessage: true,
    directIdempotencyKey: "announce-failed-parent",
    requesterIsSubagent: false,
  },
  shouldDeliverAgentFinal: true,
  subagentDirectMessageCompletionRequiresMessageTool: false,
  isSubagentCompletion: true,
};

// In-process dispatch rejects with the command error as its cause.
const turnFailure = (cause: Error) => new Error("agent turn failed", { cause });

describe("resolveFailedAnnounceResponse", () => {
  it.each([
    {
      name: "sends the child result when the parent turn failed before it started",
      // The command owner marks a run that failed before execution started.
      error: turnFailure(
        Object.assign(
          new FailoverError("access program unavailable", {
            reason: "format",
            code: "OPENAI_ACCESS_PROGRAM_UNAVAILABLE",
          }),
          { providerStarted: false },
        ),
      ),
      sendsText: true,
    },
    {
      name: "sends the child result when the parent model ended without a terminal response",
      error: turnFailure(
        new FailoverError("openai/gpt-5.5 ended with an incomplete terminal response", {
          reason: "format",
          code: "incomplete_result",
        }),
      ),
      sendsText: true,
    },
    {
      // Its model may already have sent the result with a tool before the turn failed.
      name: "does not resend after the parent turn started and then failed",
      error: turnFailure(new FailoverError("upstream timed out", { reason: "timeout" })),
      sendsText: false,
    },
  ])("$name", ({ error, sendsText }) => {
    const failure = { delivered: false, path: "direct", error: "agent turn failed" };

    expect(resolveFailedAnnounceResponse(owedFinal, error)).toEqual(
      sendsText ? { action: "send-text", unavailable: failure } : failure,
    );
  });
});
