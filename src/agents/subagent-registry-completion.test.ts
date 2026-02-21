import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const lifecycleMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => lifecycleMocks.getGlobalHookRunner(),
}));

import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";

function createRunEntry(): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "task",
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

describe("emitSubagentEndedHookOnce", () => {
  beforeEach(() => {
    lifecycleMocks.getGlobalHookRunner.mockReset();
    lifecycleMocks.runSubagentEnded.mockClear();
  });

  it("records ended hook marker even when no subagent_ended hooks are registered", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => false,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const entry = createRunEntry();
    const persist = vi.fn();
    const emitted = await emitSubagentEndedHookOnce({
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: "acct-1",
      inFlightRunIds: new Set<string>(),
      persist,
    });

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(typeof entry.endedHookEmittedAt).toBe("number");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("runs subagent_ended hooks when available", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const entry = createRunEntry();
    const persist = vi.fn();
    const emitted = await emitSubagentEndedHookOnce({
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: "acct-1",
      inFlightRunIds: new Set<string>(),
      persist,
    });

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(typeof entry.endedHookEmittedAt).toBe("number");
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
