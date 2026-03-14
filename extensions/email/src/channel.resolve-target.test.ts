import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { emailPlugin } from "./channel.js";

describe("email outbound resolveTarget", () => {
  const resolver = emailPlugin.outbound?.resolveTarget;

  it("accepts explicit to address", () => {
    const result = resolver?.({ to: "juno@zhcinstitute.com" });
    expect(result).toEqual({ ok: true, to: "juno@zhcinstitute.com" });
  });

  it("falls back to first non-wildcard allowFrom email", () => {
    const result = resolver?.({
      allowFrom: ["*@example.com", "juno@zhcinstitute.com"],
    });
    expect(result).toEqual({ ok: true, to: "juno@zhcinstitute.com" });
  });

  it("rejects wildcard-only allowFrom entries", () => {
    const result = resolver?.({ allowFrom: ["*@example.com"] });
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.error.message).toContain("Email target required");
    }
  });

  it("ignores wildcard entries with whitespace", () => {
    const result = resolver?.({
      allowFrom: ["  *@example.com  ", "  team@openclaw.ai  "],
    });
    expect(result).toEqual({ ok: true, to: "team@openclaw.ai" });
  });

  it("keeps resolveTarget stable when cfg/accountId are passed", () => {
    const cfg = { channels: { email: { accounts: {} } } } as unknown as OpenClawConfig;
    const result = resolver?.({
      cfg,
      accountId: "default",
      allowFrom: ["*@example.com", "ops@openclaw.ai"],
      mode: "auto",
    });
    expect(result).toEqual({ ok: true, to: "ops@openclaw.ai" });
  });
});
