import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectZaloAccount,
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "./accounts.js";
import { zaloPlugin } from "./channel.js";
import type { ZaloConfig } from "./types.js";

const config = (zalo: ZaloConfig): OpenClawConfig => ({ channels: { zalo } });

describe("resolveZaloAccount", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = config({
      botToken: "default-token",
      accounts: { work: { enabled: false, botToken: "work-token" } },
    });

    expect(listZaloAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultZaloAccountId(cfg)).toBe("default");
    expect(resolveZaloAccount({ cfg, accountId: "default" }).enabled).toBe(true);
  });

  it("carries account-owned unavailable credential diagnostics into the resolved account", () => {
    const tokenFile = "/private/zalo-resolved-account-token";
    const resolved = resolveZaloAccount({
      cfg: config({ botToken: "lower-priority-token", accounts: { work: { tokenFile } } }),
      accountId: "work",
    });

    expect(resolved).toMatchObject({
      token: "",
      tokenSource: "configFile",
      tokenStatus: "configured_unavailable",
      credentialDiagnostics: [
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.zalo.accounts.work.tokenFile",
          reason: "not-found",
        },
      ],
    });
    expect(JSON.stringify(resolved.credentialDiagnostics)).not.toContain(tokenFile);
  });
  const unresolvedRef = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_TEST_MISSING_ZALO_TOKEN",
  };

  it.each([
    { botToken: "bot-token", webhookUrl: undefined, mode: "polling" },
    {
      botToken: unresolvedRef,
      webhookUrl: "https://bot.example.com/zalo",
      mode: "webhook",
    },
  ])("reports configured $mode inspection", async (entry) => {
    const cfg = config({
      accounts: {
        work: { botToken: entry.botToken, webhookUrl: entry.webhookUrl, dmPolicy: "open" },
      },
    });
    const account = inspectZaloAccount({ cfg, accountId: "work" });
    expect(await zaloPlugin.config.isConfigured?.(account, cfg)).toBe(true);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: true,
      mode: entry.mode,
      dmPolicy: "open",
    });
  });

  it("keeps direct account resolution strict", () => {
    expect(() => resolveZaloAccount({ cfg: config({ botToken: unresolvedRef }) })).toThrow(
      /unresolved SecretRef/,
    );
  });

  it("does not fall through an unavailable configured ref to the environment", () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "lower-precedence-token");
    const account = inspectZaloAccount({ cfg: config({ botToken: unresolvedRef }) });
    expect(account).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    });
  });
});
