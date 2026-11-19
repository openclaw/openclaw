// Continuation (karmaterminal): rehomed from attempt.cwd-split.test.ts when upstream folded that
// suite away (#198916); this is the fork's only case from it.
import { describe, expect, it } from "vitest";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";

const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:subagent:child");

describe("runEmbeddedAttempt continuation tools", () => {
  it("forwards explicit continuation-tool disablement into runtime tools", async () => {
    // Upstream removed the Tasks/TaskFlow runtime (#159179), so a cron run no
    // longer settles by reading completion-required task records; the
    // in-memory task/flow store setup this case once needed is gone with it.
    await runAttempt({
      sessionKey: "agent:main:cron:job:run:attempt",
      attemptOverrides: {
        disableTools: false,
        disableContinuationTools: true,
      },
    });

    // Assert the forwarded options, not the call arity: the factory is invoked
    // with (options, skillReadResources), so a single-argument
    // `toHaveBeenCalledWith` never matches.
    expect(hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0]).toMatchObject({
      disableContinuationTools: true,
    });
  });
});
