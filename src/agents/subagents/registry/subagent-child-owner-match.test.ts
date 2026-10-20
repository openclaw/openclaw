import { describe, expect, it, vi } from "vitest";
import {
  resolveSubagentChildAuthority,
  warnLegacySubagentAuthority,
} from "./subagent-child-owner-match.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const identity = { sessionId: "child-session", lifecycleRevision: "child-revision" };
const owned = {
  childSessionKey: "agent:worker:subagent:child",
  requesterSessionKey: "agent:parent:main",
  childSessionIdentity: identity,
};

describe("subagent child authority policy", () => {
  it.each([
    { name: "verified qualified owner", entry: owned, current: identity, status: "verified" },
    {
      name: "recorded identity without a current observation",
      entry: owned,
      current: undefined,
      status: "verified",
    },
    {
      name: "verified raw owner",
      entry: { ...owned, childSessionKey: "global", childAgentId: "worker" },
      current: identity,
      status: "verified",
    },
    {
      name: "missing original identity",
      entry: { ...owned, childSessionIdentity: undefined },
      current: identity,
      status: "legacy-unverified",
    },
    {
      name: "missing original revision",
      entry: { ...owned, childSessionIdentity: { sessionId: identity.sessionId } },
      current: identity,
      status: "legacy-unverified",
    },
    {
      name: "missing both revisions",
      entry: { ...owned, childSessionIdentity: { sessionId: identity.sessionId } },
      current: { sessionId: identity.sessionId },
      status: "legacy-unverified",
    },
    {
      name: "unknown child owner",
      entry: { ...owned, childSessionKey: "global" },
      current: identity,
      status: "mismatch",
    },
    {
      name: "unknown legacy requester",
      entry: { ...owned, childSessionIdentity: undefined, requesterSessionKey: "global" },
      current: identity,
      status: "mismatch",
    },
    {
      name: "conflicting explicit owner",
      entry: { ...owned, childAgentId: "other" },
      current: identity,
      status: "mismatch",
    },
    {
      name: "changed session",
      entry: owned,
      current: { ...identity, sessionId: "replacement-session" },
      status: "mismatch",
    },
    {
      name: "changed revision",
      entry: owned,
      current: { ...identity, lifecycleRevision: "replacement-revision" },
      status: "mismatch",
    },
    {
      name: "lost known revision",
      entry: owned,
      current: { sessionId: identity.sessionId },
      status: "mismatch",
    },
    { name: "lost known session", entry: owned, current: null, status: "mismatch" },
  ])("$name", ({ entry, current, status }) => {
    const result = resolveSubagentChildAuthority(entry, current);
    expect(result.status).toBe(status);
    if (result.status !== "mismatch") {
      expect(result.childAgentId).toBe("worker");
      expect(result.requesterAgentId).toBe("parent");
    }
  });

  it("summarizes unsettled legacy runs once per process, deduplicating only by run ID", () => {
    const warn = vi.fn();
    const entries: SubagentRunRecord[] = Array.from({ length: 5000 }, (_, index) => ({
      ...owned,
      runId: `legacy-population-${index}`,
      createdAt: index,
      requesterDisplayKey: "parent",
      task: "legacy population",
      cleanup: "keep",
      execution: { status: "running" },
      childSessionIdentity: undefined,
    }));
    const verified = { ...entries[0]!, childSessionIdentity: identity };
    const mismatch = { ...entries[0]!, childSessionKey: "global" };
    const settled: SubagentRunRecord[] = [
      {
        ...entries[0]!,
        runId: "cleaned-terminal",
        execution: { status: "terminal" },
        cleanupCompletedAt: 1,
      },
      { ...entries[0]!, runId: "cleaned-running", cleanupCompletedAt: 1 },
      {
        ...entries[0]!,
        runId: "suppressed-terminal",
        execution: { status: "terminal" },
        suppressCompletionDelivery: true,
      },
    ];
    warnLegacySubagentAuthority([], warn);
    warnLegacySubagentAuthority([verified, mismatch, ...settled], warn);
    expect(warn).not.toHaveBeenCalled();

    for (const entry of settled) {
      entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    }
    warnLegacySubagentAuthority(
      [
        verified,
        mismatch,
        ...entries.flatMap((entry) => [
          entry,
          { ...entry, createdAt: entry.createdAt + 1, generation: 2 },
        ]),
        ...settled,
        { ...entries[0]!, runId: "suppressed-running", suppressCompletionDelivery: true },
      ],
      warn,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("child-session effects suppressed"),
      {
        count: 5004,
        sampleRunIds: ["legacy-population-0", "legacy-population-1", "legacy-population-2"],
      },
    );
    warnLegacySubagentAuthority(entries, warn);
    warnLegacySubagentAuthority([{ ...entries[0]!, runId: "later-legacy-run" }], warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
