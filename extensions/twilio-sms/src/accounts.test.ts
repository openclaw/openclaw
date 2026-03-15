import type { OpenClawConfig } from "openclaw/plugin-sdk/twilio-sms";
import { describe, expect, it } from "vitest";
import {
  listTwilioSmsAccountIds,
  resolveDefaultTwilioSmsAccountId,
  resolveTwilioSmsAccount,
} from "./accounts.js";

function createCfg(channelConfig: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { "twilio-sms": channelConfig } } as OpenClawConfig;
}

describe("resolveTwilioSmsAccount", () => {
  it("resolves configured account with all required fields", () => {
    const cfg = createCfg({
      accountSid: "ACtest",
      authToken: "tok",
      phoneNumber: "+15551234567",
    });
    const account = resolveTwilioSmsAccount({ cfg });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
    expect(account.accountId).toBe("default");
    expect(account.config.accountSid).toBe("ACtest");
  });

  it("returns not configured when accountSid is missing", () => {
    const cfg = createCfg({
      authToken: "tok",
      phoneNumber: "+15551234567",
    });
    const account = resolveTwilioSmsAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("returns not configured when authToken is missing", () => {
    const cfg = createCfg({
      accountSid: "ACtest",
      phoneNumber: "+15551234567",
    });
    const account = resolveTwilioSmsAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("returns not configured when phoneNumber is missing", () => {
    const cfg = createCfg({
      accountSid: "ACtest",
      authToken: "tok",
    });
    const account = resolveTwilioSmsAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("returns disabled when enabled is false", () => {
    const cfg = createCfg({
      enabled: false,
      accountSid: "ACtest",
      authToken: "tok",
      phoneNumber: "+15551234567",
    });
    const account = resolveTwilioSmsAccount({ cfg });
    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });

  it("resolves multi-account config", () => {
    const cfg = createCfg({
      accountSid: "ACdefault",
      authToken: "tok-default",
      phoneNumber: "+15551111111",
      accounts: {
        secondary: {
          accountSid: "ACsecondary",
          authToken: "tok-secondary",
          phoneNumber: "+15552222222",
        },
      },
    });

    const defaultAccount = resolveTwilioSmsAccount({ cfg });
    expect(defaultAccount.config.accountSid).toBe("ACdefault");

    const secondary = resolveTwilioSmsAccount({ cfg, accountId: "secondary" });
    expect(secondary.config.accountSid).toBe("ACsecondary");
    expect(secondary.config.phoneNumber).toBe("+15552222222");
    expect(secondary.configured).toBe(true);
  });

  it("inherits base fields into account-level config", () => {
    const cfg = createCfg({
      accountSid: "ACbase",
      authToken: "tok-base",
      phoneNumber: "+15551111111",
      dmPolicy: "allowlist",
      accounts: {
        secondary: {
          phoneNumber: "+15552222222",
        },
      },
    });

    const secondary = resolveTwilioSmsAccount({ cfg, accountId: "secondary" });
    // Inherits accountSid/authToken from base
    expect(secondary.config.accountSid).toBe("ACbase");
    expect(secondary.config.authToken).toBe("tok-base");
    // Uses its own phoneNumber
    expect(secondary.config.phoneNumber).toBe("+15552222222");
    // Inherits dmPolicy from base
    expect(secondary.config.dmPolicy).toBe("allowlist");
  });

  it("returns empty config when no channel config exists", () => {
    const cfg = {} as OpenClawConfig;
    const account = resolveTwilioSmsAccount({ cfg });
    expect(account.configured).toBe(false);
    expect(account.enabled).toBe(true);
  });
});

describe("listTwilioSmsAccountIds", () => {
  it("returns default when no accounts section", () => {
    const cfg = createCfg({ accountSid: "ACtest" });
    const ids = listTwilioSmsAccountIds(cfg);
    expect(ids).toContain("default");
  });

  it("lists named accounts", () => {
    const cfg = createCfg({
      accounts: {
        primary: { accountSid: "ACprimary" },
        secondary: { accountSid: "ACsecondary" },
      },
    });
    const ids = listTwilioSmsAccountIds(cfg);
    expect(ids).toContain("primary");
    expect(ids).toContain("secondary");
  });
});

describe("resolveDefaultTwilioSmsAccountId", () => {
  it("returns default when no defaultAccount configured", () => {
    const cfg = createCfg({});
    expect(resolveDefaultTwilioSmsAccountId(cfg)).toBe("default");
  });
});
