import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordToken } from "./token.js";

describe("resolveDiscordToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers config token over env", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { discord: { token: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("uses env token when config is missing", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("env-token");
    expect(res.source).toBe("env");
  });

  it("prefers account token for non-default accounts", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: { token: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("falls back to top-level token for non-default accounts without account token", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("base-token");
    expect(res.source).toBe("config");
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: { token: "" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves account token when account key casing differs from normalized id", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            Work: { token: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("falls through to env when config token is an unresolved SecretRef object", () => {
    // The channel startup path reads raw config before the gateway has resolved channel
    // SecretRefs into a runtime snapshot. Treating an unresolved SecretRef as "no usable
    // config token here" lets the env fallback (matching the SecretRef's intent in this
    // common case) take over instead of crashing the channel start.
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("env-token");
    expect(res.source).toBe("env");
  });

  it("returns source=none when config token is an unresolved SecretRef and env is also absent", () => {
    const cfg = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not throw and returns source=none when account token is an unresolved SecretRef and base/env are absent", () => {
    // Mirrors the existing "explicit blank means no inheritance" semantics — a SecretRef
    // object at account level is treated as an explicit-but-unresolved token: do not
    // inherit the base token, but also do not crash channel startup.
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: {
              token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });
});
