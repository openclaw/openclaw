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

  it("does not mark ended runs stale", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: { endedAt: now - 1 },
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("extends stale cutoff for explicit long run timeouts", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      runTimeoutSeconds: 6 * 60 * 60,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("ignores non-real fixture timestamps as unknown instead of stale", () => {
    // Small fixture timestamps appear in tests and old synthetic records; they
    // should not be interpreted as Unix epoch production runs.
    const entry = {
      runId: "unowned-retention-row",
      createdAt: 100,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("keeps child links during registration grace, recent completion, or pending descendants", () => {
    expect(
      shouldKeepSubagentRunChildLink(
        { runId: "unowned-retention-row", createdAt: now - 60_000, execution: {} },
        { now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS + 1 },
        },
        { now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 1 },
        },
        { now },
      ),
    ).toBe(false);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 1 },
        },
        { activeDescendants: 1, now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
          execution: {},
        },
        { now },
      ),
    ).toBe(false);
  });
});
