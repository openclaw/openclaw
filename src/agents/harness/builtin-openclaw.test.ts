// Built-in OpenClaw harness tests cover logical thinking-mode boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runEmbeddedAttempt = vi.hoisted(() => vi.fn());

vi.mock("../embedded-agent-runner/run/attempt.js", () => ({ runEmbeddedAttempt }));

import { createOpenClawAgentHarness } from "./builtin-openclaw.js";

describe("createOpenClawAgentHarness", () => {
  beforeEach(() => {
    runEmbeddedAttempt.mockReset();
    runEmbeddedAttempt.mockResolvedValue({});
  });

  it("preserves logical Ultra for the embedded attempt", async () => {
    const params = { thinkLevel: "ultra" } as never;

    await createOpenClawAgentHarness().runAttempt(params);

    expect(runEmbeddedAttempt).toHaveBeenCalledWith(params);
  });

  it("enforces a tool-free settled-turn finalization", async () => {
    const attempt = { prompt: "finalize", disableTools: false } as never;
    const harness = createOpenClawAgentHarness();

    await harness.finalizeSettledTurn?.({ attempt, settledAttempt: {} as never });

    expect(runEmbeddedAttempt).toHaveBeenCalledWith({
      prompt: "finalize",
      disableTools: true,
    });
  });
});
