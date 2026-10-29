// Subagent run liveness tests cover stale-unended detection and child-link
// retention windows for registry list/read paths.
import { describe, expect, it } from "vitest";
import {
  copySubagentRunRuntimeOwner,
  isSameSubagentRun,
  isSameSubagentRunOwner,
  type SubagentRunIdentity,
} from "./subagent-run-generation.js";
import {
  isRetainedUnendedSubagentRun,
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  isStaleUnendedSubagentRun,
  shouldKeepSubagentRunChildLink,
} from "./subagent-run-liveness.js";

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

describe("subagent run liveness", () => {
  const now = Date.parse("2026-04-25T12:00:00Z");

  const identity: SubagentRunIdentity = {
    runId: "identity-run",
    taskRunId: "identity-task",
    generation: 1,
    createdAt: now,
    childSessionKey: "agent:child:subagent:identity",
    childAgentId: "child",
    requesterSessionKey: "agent:parent:main",
    requesterAgentId: "parent",
    requesterStorePath: "/synthetic/parent/sessions",
  };

  it.each([
    { runId: "replacement" },
    { taskRunId: "replacement" },
    { generation: 2 },
    { createdAt: now + 1 },
    { childSessionKey: "agent:child:subagent:replacement" },
    { childAgentId: "replacement" },
    { requesterSessionKey: "agent:parent:replacement" },
    { requesterAgentId: "replacement" },
    { requesterStorePath: "/synthetic/replacement/sessions" },
  ])("rejects changed durable identity despite retained runtime custody: %j", (replacement) => {
    const copied = copySubagentRunRuntimeOwner(identity, { ...identity });
    expect(isSameSubagentRunOwner(identity, copied)).toBe(true);
    Object.assign(copied, replacement);
    expect(isSameSubagentRunOwner(identity, copied)).toBe(false);
  });

  it("preserves default task/generation and nonfinite timestamp identity semantics", () => {
    const legacy = { runId: "legacy", createdAt: Number.NaN };
    expect(isSameSubagentRun(legacy, { ...legacy, taskRunId: "legacy", generation: 0 })).toBe(true);
    expect(isSameSubagentRun(legacy, { ...legacy, createdAt: Number.POSITIVE_INFINITY })).toBe(
      true,
    );
    expect(isSameSubagentRun(legacy, { ...legacy, createdAt: now })).toBe(false);
    expect(isSameSubagentRun(legacy, undefined)).toBe(false);
  });

  const stale = now - STALE_UNENDED_SUBAGENT_RUN_MS - 1;
  const recent = now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS;
  it.each([
    ["ended", { createdAt: stale, execution: { endedAt: now - 1 } }, false],
    ["long timeout", { createdAt: stale, runTimeoutSeconds: 6 * 60 * 60, execution: {} }, true],
    ["unknown fixture timestamp", { createdAt: 100, execution: {} }, true],
  ] as const)("does not mark %s stale", (_case, fields, retained) => {
    const entry = { runId: "unowned-retention-row", ...fields };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(retained);
  });

  it.each([
    ["registration grace", now - 60_000, undefined, undefined, true],
    ["recent completion", recent - 60_000, recent + 1, undefined, true],
    ["expired completion", recent - 60_000, recent - 1, undefined, false],
    ["active descendant", recent - 60_000, recent - 1, 1, true],
    ["stale unended", stale, undefined, undefined, false],
  ] as const)(
    "checks child-link retention for %s",
    (_case, createdAt, endedAt, activeDescendants, retained) => {
      const entry = {
        runId: "unowned-retention-row",
        createdAt,
        execution: endedAt === undefined ? {} : { endedAt },
      };
      expect(shouldKeepSubagentRunChildLink(entry, { now, activeDescendants })).toBe(retained);
    },
  );
});
