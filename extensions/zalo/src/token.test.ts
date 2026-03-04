import { describe, expect, it } from "vitest";
import { resolveZaloToken } from "./token.js";
import type { ZaloConfig } from "./types.js";

describe("resolveZaloToken", () => {
  it("falls back to top-level token for non-default accounts without overrides", () => {
    const cfg = {
      botToken: "top-level-token",
      accounts: {
        work: {},
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "work");
    expect(res.token).toBe("top-level-token");
    expect(res.source).toBe("config");
  });

  it("uses accounts.default botToken for default account when configured", () => {
    const cfg = {
      botToken: "top-level-token",
      accounts: {
        default: {
          botToken: "default-account-token",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "default");
    expect(res.token).toBe("default-account-token");
    expect(res.source).toBe("config");
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    const cfg = {
      botToken: "top-level-token",
      accounts: {
        work: {
          botToken: "",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "work");
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves account token when account key casing differs from normalized id", () => {
    const cfg = {
      accounts: {
        Work: {
          botToken: "work-token",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "work");
    expect(res.token).toBe("work-token");
    expect(res.source).toBe("config");
  });
});
