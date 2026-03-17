import { describe, expect, it } from "vitest";
import { resolveTlonOutboundTarget } from "./targets.js";

describe("resolveTlonOutboundTarget", () => {
  it("resolves dm targets to normalized ships", () => {
    expect(resolveTlonOutboundTarget("dm/sampel-palnet")).toEqual({
      ok: true,
      to: "~sampel-palnet",
    });
  });

  it("resolves group targets to canonical chat nests", () => {
    expect(resolveTlonOutboundTarget("group:host-ship/general")).toEqual({
      ok: true,
      to: "chat/~host-ship/general",
    });
  });

  it("returns a helpful error for invalid targets", () => {
    const resolved = resolveTlonOutboundTarget("group:bad-target");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected invalid target");
    }
    expect(resolved.error.message).toMatch(/invalid tlon target/i);
  });
});
