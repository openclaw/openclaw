import { describe, expect, it } from "vitest";
import { mergeAcceptedSessionSpawnsForRun } from "./accepted-session-spawn.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";

describe("mergeAcceptedSessionSpawnsForRun", () => {
  it("keeps the first acceptance and adds later collection evidence", () => {
    const instance: OperationalRunInstanceRef = { instanceId: "instance-a", runId: "parent-run" };
    const accepted = { runId: "run-a", childSessionKey: "agent:main:subagent:a", label: "first" };
    mergeAcceptedSessionSpawnsForRun(instance, [accepted]);

    expect(
      mergeAcceptedSessionSpawnsForRun(instance, [
        { runId: "run-a", childSessionKey: "agent:main:subagent:other", collected: true },
      ]),
    ).toEqual([{ ...accepted, collected: true }]);
    expect(
      mergeAcceptedSessionSpawnsForRun(instance, [
        { runId: "run-a", childSessionKey: "agent:main:subagent:a" },
      ]),
    ).toEqual([{ ...accepted, collected: true }]);
  });
});
