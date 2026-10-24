import { expect, it, vi } from "vitest";
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
const noIdentity = { childSessionIdentity: undefined };
const sessionOnly = { sessionId: identity.sessionId };
const noRevision = { childSessionIdentity: sessionOnly };
const ownership = { childAgentId: "worker", requesterAgentId: "parent" };

it.each([
  ["verified qualified owner", {}, identity, "verified"],
  ["unobserved current identity", {}, undefined, "verified"],
  ["raw owner", { childSessionKey: "global", childAgentId: "worker" }, identity, "verified"],
  ["missing original identity", noIdentity, identity, "legacy-unverified"],
  ["missing original revision", noRevision, identity, "legacy-unverified"],
  ["missing both revisions", noRevision, sessionOnly, "legacy-unverified"],
  ["unknown child owner", { childSessionKey: "global" }, identity, "mismatch"],
  ["unknown requester", { ...noIdentity, requesterSessionKey: "global" }, identity, "mismatch"],
  ["conflicting explicit owner", { childAgentId: "other" }, identity, "mismatch"],
  ["changed session", {}, { ...identity, sessionId: "replacement-session" }, "mismatch"],
  ["changed revision", {}, { ...identity, lifecycleRevision: "new-revision" }, "mismatch"],
  ["lost known revision", {}, sessionOnly, "mismatch"],
  ["lost known session", {}, null, "mismatch"],
] as const)("%s", (_name, entry, current, status) => {
  const result = resolveSubagentChildAuthority({ ...owned, ...entry }, current);
  expect(result).toMatchObject(status === "mismatch" ? { status } : { status, ...ownership });
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
