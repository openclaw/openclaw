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

  it("reports legacy suppression once across row publication copies", () => {
    const entry: SubagentRunRecord = {
      ...owned,
      runId: "legacy-warning-policy",
      createdAt: 23,
      requesterDisplayKey: "parent",
      task: "legacy warning",
      cleanup: "keep",
      execution: { status: "running" },
      childSessionIdentity: undefined,
    };
    const warn = vi.fn();
    warnLegacySubagentAuthority(entry, warn);
    warnLegacySubagentAuthority({ ...entry }, warn);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("child-session effects suppressed"),
      { runId: entry.runId },
    );
  });
});
