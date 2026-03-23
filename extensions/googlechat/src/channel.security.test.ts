import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { googlechatPlugin } from "./channel.js";

describe("googlechatPlugin security", () => {
  it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
    const security = googlechatPlugin.security;
    if (!security) {
      throw new Error("googlechat security unavailable");
    }
    const resolveDmPolicy = security.resolveDmPolicy;
    const normalizeAllowEntry = googlechatPlugin.pairing?.normalizeAllowEntry;
    expect(resolveDmPolicy).toBeTypeOf("function");
    expect(normalizeAllowEntry).toBeTypeOf("function");

    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: {
            policy: "allowlist",
            allowFrom: ["  googlechat:user:Bob@Example.com  "],
          },
        },
      },
    } as OpenClawConfig;

    const account = googlechatPlugin.config.resolveAccount(cfg, "default");
    const resolved = resolveDmPolicy!({ cfg, account });
    if (!resolved) {
      throw new Error("googlechat resolveDmPolicy returned null");
    }

    expect(resolved.policy).toBe("allowlist");
    expect(resolved.allowFrom).toEqual(["  googlechat:user:Bob@Example.com  "]);
    expect(resolved.normalizeEntry?.("  googlechat:user:Bob@Example.com  ")).toBe(
      "bob@example.com",
    );
    expect(normalizeAllowEntry!("  users/Alice@Example.com  ")).toBe("alice@example.com");
  });
});
