import type { OpenClawConfig } from "openclaw/plugin-sdk/campfire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCampfireAccount } from "./accounts.js";

function makeCfg(campfire: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { campfire } } as unknown as OpenClawConfig;
}

describe("resolveCampfireAccount", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves inline botKey + baseUrl (source: 'inline')", () => {
    const cfg = makeCfg({ botKey: "123-abc", baseUrl: "https://camp.example.com" });
    const account = resolveCampfireAccount({ cfg });
    expect(account.credentialSource).toBe("inline");
    expect(account.botKey).toBe("123-abc");
    expect(account.baseUrl).toBe("https://camp.example.com");
  });

  it("resolves from env vars for default account (source: 'env')", () => {
    vi.stubEnv("CAMPFIRE_BOT_KEY", "456-def");
    vi.stubEnv("CAMPFIRE_BASE_URL", "https://env.example.com");
    const cfg = makeCfg({});
    const account = resolveCampfireAccount({ cfg });
    expect(account.credentialSource).toBe("env");
    expect(account.botKey).toBe("456-def");
    expect(account.baseUrl).toBe("https://env.example.com");
  });

  it("prefers inline over env when both present", () => {
    vi.stubEnv("CAMPFIRE_BOT_KEY", "456-def");
    vi.stubEnv("CAMPFIRE_BASE_URL", "https://env.example.com");
    const cfg = makeCfg({ botKey: "123-abc", baseUrl: "https://inline.example.com" });
    const account = resolveCampfireAccount({ cfg });
    expect(account.credentialSource).toBe("inline");
    expect(account.botKey).toBe("123-abc");
    expect(account.baseUrl).toBe("https://inline.example.com");
  });

  it("returns source 'none' when no credentials", () => {
    const cfg = makeCfg({});
    const account = resolveCampfireAccount({ cfg });
    expect(account.credentialSource).toBe("none");
    expect(account.botKey).toBeUndefined();
    expect(account.baseUrl).toBeUndefined();
  });

  it("merges base config with account-specific config", () => {
    const cfg = makeCfg({
      botKey: "base-key",
      baseUrl: "https://base.example.com",
      requireMention: true,
      accounts: {
        work: {
          botKey: "work-key",
          baseUrl: "https://work.example.com",
        },
      },
    });
    const account = resolveCampfireAccount({ cfg, accountId: "work" });
    expect(account.credentialSource).toBe("inline");
    expect(account.botKey).toBe("work-key");
    expect(account.baseUrl).toBe("https://work.example.com");
    // Base config is merged
    expect(account.config.requireMention).toBe(true);
  });

  it("respects enabled flag from base and account level", () => {
    const cfg = makeCfg({
      enabled: true,
      botKey: "k",
      baseUrl: "https://x.com",
      accounts: { work: { enabled: false, botKey: "w", baseUrl: "https://w.com" } },
    });
    const account = resolveCampfireAccount({ cfg, accountId: "work" });
    expect(account.enabled).toBe(false);
  });

  it("handles partial credentials (botKey without baseUrl)", () => {
    const cfg = makeCfg({ botKey: "123-abc" });
    const account = resolveCampfireAccount({ cfg });
    // Partial inline — still reports as inline source but baseUrl is missing
    expect(account.credentialSource).toBe("inline");
    expect(account.botKey).toBe("123-abc");
    expect(account.baseUrl).toBeUndefined();
  });
});
