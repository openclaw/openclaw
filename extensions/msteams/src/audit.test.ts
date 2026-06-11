import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildMSTeamsAuditLine, resolveMSTeamsAuditTarget } from "./audit.js";

const cfgWith = (auditChannel?: string): OpenClawConfig =>
  ({ channels: { msteams: auditChannel ? { auditChannel } : {} } }) as unknown as OpenClawConfig;

describe("msteams audit channel (#15)", () => {
  it("returns null when auditing is off", () => {
    expect(resolveMSTeamsAuditTarget(cfgWith(), "conversation:19:abc")).toBeNull();
  });

  it("returns the audit target for a normal source conversation", () => {
    expect(resolveMSTeamsAuditTarget(cfgWith("conversation:19:audit"), "conversation:19:abc")).toBe(
      "conversation:19:audit",
    );
  });

  it("loop-guards: never mirrors the audit channel's own traffic (prefixed or bare)", () => {
    const cfg = cfgWith("conversation:19:audit");
    expect(resolveMSTeamsAuditTarget(cfg, "conversation:19:audit")).toBeNull();
    expect(resolveMSTeamsAuditTarget(cfg, "19:audit")).toBeNull();
  });

  it("builds a compact audit line with sender, conversation, and excerpt", () => {
    const line = buildMSTeamsAuditLine({
      sourceConversationId: "19:abc",
      senderName: "Sara",
      text: "the budget is on track",
    });
    expect(line).toContain("for Sara");
    expect(line).toContain("in 19:abc");
    expect(line).toContain("the budget is on track");
  });

  it("omits sender/conversation when unknown and truncates long text", () => {
    const line = buildMSTeamsAuditLine({ text: "x".repeat(1000) });
    expect(line).not.toContain(" for ");
    expect(line).not.toContain(" in ");
    expect(line.length).toBeLessThan(700);
  });
});
