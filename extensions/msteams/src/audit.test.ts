import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildMSTeamsAuditLine, resolveMSTeamsAuditTarget } from "./audit.js";

const cfgWith = (auditChannel?: string, dlp?: { enabled: boolean }): OpenClawConfig =>
  ({
    channels: { msteams: { ...(auditChannel ? { auditChannel } : {}), ...(dlp ? { dlp } : {}) } },
  }) as unknown as OpenClawConfig;

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
      cfg: cfgWith(),
      sourceConversationId: "19:abc",
      senderName: "Sara",
      text: "the budget is on track",
    });
    expect(line).toContain("for Sara");
    expect(line).toContain("in 19:abc");
    expect(line).toContain("the budget is on track");
  });

  it("omits sender/conversation when unknown and truncates long text", () => {
    const line = buildMSTeamsAuditLine({ cfg: cfgWith(), text: "x".repeat(1000) });
    expect(line).not.toContain(" for ");
    expect(line).not.toContain(" in ");
    expect(line.length).toBeLessThan(700);
  });

  it("redacts BEFORE truncating so the excerpt can't carry a cut secret fragment (S5)", () => {
    // Pad so the secret straddles the excerpt cap: truncate-then-redact would slice the secret
    // mid-match, leaving an unrecognizable (and unredactable) fragment in the audit trail.
    const secret = `sk-${"a".repeat(40)}`;
    const line = buildMSTeamsAuditLine({
      cfg: cfgWith("conversation:19:audit", { enabled: true }),
      text: `${"x".repeat(570)} ${secret}`,
    });
    expect(line).not.toContain("sk-");
    expect(line).toContain("[REDACTED:secret]");
  });
});
