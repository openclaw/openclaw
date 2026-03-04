import { describe, expect, it } from "vitest";
import {
  __testing as brokerTesting,
  authorizeSecuritySentinelApproval,
  computeSecuritySentinelActionHash,
  issueSecuritySentinelApprovalToken,
} from "./security-approval-broker.js";

const BROKER_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_SECURITY_SENTINEL_BROKER_ENABLED: "1",
  OPENCLAW_SECURITY_SENTINEL_BROKER_SECRET: "broker-secret-test-only",
  OPENCLAW_SECURITY_SENTINEL_BROKER_LANE1_CREDENTIAL: "lane1-secret",
  OPENCLAW_SECURITY_SENTINEL_BROKER_LANE2_CREDENTIAL: "lane2-secret",
};

describe("security approval broker", () => {
  it("computes stable action hashes and excludes approval metadata", () => {
    const hashA = computeSecuritySentinelActionHash({
      toolName: "web_search",
      params: {
        q: "nvda",
        nested: {
          b: 2,
          a: 1,
          securitySentinelApproved: true,
        },
      },
    });
    const hashB = computeSecuritySentinelActionHash({
      toolName: "web_search",
      params: {
        nested: {
          a: 1,
          b: 2,
          securitySentinelToken: "will-be-ignored",
        },
        q: "nvda",
      },
    });
    expect(hashA).toBe(hashB);
  });

  it("issues and validates a one-time token for the matching lane and action hash", () => {
    brokerTesting.clearUsedNoncesForTest();
    const issue = issueSecuritySentinelApprovalToken({
      lane: "lane1",
      laneCredential: "lane1-secret",
      toolName: "web_search",
      params: { query: "warwickshire apprenticeships" },
      env: BROKER_ENV,
      nowMs: 1_000,
      ttlMs: 60_000,
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) {
      return;
    }

    const approved = authorizeSecuritySentinelApproval({
      toolName: "web_search",
      params: {
        query: "warwickshire apprenticeships",
        securitySentinelLane: "lane1",
        securitySentinelLaneCredential: "lane1-secret",
        securitySentinelToken: issue.token,
      },
      env: BROKER_ENV,
      nowMs: 1_100,
    });
    expect(approved.approved).toBe(true);

    const replay = authorizeSecuritySentinelApproval({
      toolName: "web_search",
      params: {
        query: "warwickshire apprenticeships",
        securitySentinelLane: "lane1",
        securitySentinelLaneCredential: "lane1-secret",
        securitySentinelToken: issue.token,
      },
      env: BROKER_ENV,
      nowMs: 1_200,
    });
    expect(replay.approved).toBe(false);
    expect(replay.reason).toContain("already used");
  });

  it("rejects plaintext approval when broker mode is enabled", () => {
    const blocked = authorizeSecuritySentinelApproval({
      toolName: "web_fetch",
      params: {
        url: "https://example.com",
        securitySentinelLane: "lane2",
        securitySentinelLaneCredential: "lane2-secret",
        securitySentinelApproved: true,
      },
      env: BROKER_ENV,
    });
    expect(blocked.approved).toBe(false);
    expect(blocked.reason).toContain("plaintext approvals are disabled");
  });

  it("rejects lane impersonation even with a valid token", () => {
    brokerTesting.clearUsedNoncesForTest();
    const issue = issueSecuritySentinelApprovalToken({
      lane: "lane1",
      laneCredential: "lane1-secret",
      toolName: "web_search",
      params: { query: "entry level vacancies" },
      env: BROKER_ENV,
      nowMs: 5_000,
      ttlMs: 60_000,
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) {
      return;
    }
    const blocked = authorizeSecuritySentinelApproval({
      toolName: "web_search",
      params: {
        query: "entry level vacancies",
        securitySentinelLane: "lane2",
        securitySentinelLaneCredential: "lane2-secret",
        securitySentinelToken: issue.token,
      },
      env: BROKER_ENV,
      nowMs: 5_010,
    });
    expect(blocked.approved).toBe(false);
    expect(blocked.reason).toContain("lane mismatch");
  });
});
