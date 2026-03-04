import { afterEach, describe, expect, it } from "vitest";
import {
  __testing as sessionStoreTesting,
  armSecurityApprovalForSession,
  clearArmedSecurityApprovalForSession,
  consumeArmedSecurityApprovalForSession,
  peekArmedSecurityApprovalForSession,
} from "./security-approval-session-store.js";

describe("security approval session store", () => {
  afterEach(() => {
    sessionStoreTesting.clearArmedSecurityApprovalsForTest();
  });

  it("arms and consumes one-shot approval for a session", () => {
    const armed = armSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      lane: "lane2",
      laneCredential: "lane2-secret",
      passphrase: "letmein",
      nowMs: 1_000,
      ttlMs: 60_000,
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok) {
      return;
    }

    const peeked = peekArmedSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      nowMs: 1_100,
    });
    expect(peeked).toEqual({
      lane: "lane2",
      laneCredential: "lane2-secret",
      passphrase: "letmein",
      expiresAtMs: 61_000,
    });

    const consumed = consumeArmedSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      nowMs: 1_200,
    });
    expect(consumed?.lane).toBe("lane2");
    expect(consumed?.laneCredential).toBe("lane2-secret");
    expect(consumed?.passphrase).toBe("letmein");

    const afterConsume = peekArmedSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      nowMs: 1_300,
    });
    expect(afterConsume).toBeNull();
  });

  it("normalizes lane aliases and enforces required fields", () => {
    const missing = armSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      lane: "lane2",
      laneCredential: "",
    });
    expect(missing.ok).toBe(false);

    const ownerLane = armSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      lane: "owner",
      laneCredential: "lane1-secret",
    });
    expect(ownerLane.ok).toBe(true);
    if (!ownerLane.ok) {
      return;
    }
    expect(ownerLane.lane).toBe("lane1");
  });

  it("expires armed approvals and supports explicit clear", () => {
    const armed = armSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      lane: "lane2",
      laneCredential: "lane2-secret",
      nowMs: 1_000,
      ttlMs: 1_500,
    });
    expect(armed.ok).toBe(true);

    const expired = consumeArmedSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      nowMs: 2_600,
    });
    expect(expired).toBeNull();

    const armedAgain = armSecurityApprovalForSession({
      sessionKey: "agent:main:main",
      lane: "lane2",
      laneCredential: "lane2-secret",
    });
    expect(armedAgain.ok).toBe(true);

    clearArmedSecurityApprovalForSession("agent:main:main");
    const cleared = peekArmedSecurityApprovalForSession({
      sessionKey: "agent:main:main",
    });
    expect(cleared).toBeNull();
  });
});
