import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
// iMessage Spectrum account tests cover cross-platform channel config resolution.
import { describe, expect, it } from "vitest";
import { resolveDefaultSpectrumAccountId, resolveSpectrumAccount } from "./accounts.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("resolveDefaultSpectrumAccountId", () => {
  it("uses the implicit default account when no accounts are configured", () => {
    expect(resolveDefaultSpectrumAccountId(asConfig({}))).toBe("default");
  });
});

describe("resolveSpectrumAccount", () => {
  it("normalizes webhook URL and applies reliability defaults", () => {
    const account = resolveSpectrumAccount({
      cfg: asConfig({
        channels: {
          "imessage-spectrum": {
            projectId: "project",
            projectSecret: "secret",
            webhookSecret: "signing",
            webhookBaseUrl: "https://imessage.example.com///",
          },
        },
      }),
    });

    expect(account.configured).toBe(true);
    expect(account.webhookConfigured).toBe(true);
    expect(account.webhookBaseUrl).toBe("https://imessage.example.com");
    expect(account.deliveryRetryCount).toBe(3);
    expect(account.deliveryRetryDelayMs).toBe(1500);
    expect(account.deliveryQueueSize).toBe(100);
    expect(account.enableSessionContext).toBe(true);
    expect(account.catchupLookbackCount).toBe(25);
    expect(account.catchupIntervalMs).toBe(30000);
  });

  it("clamps retry and queue settings to bounded values", () => {
    const account = resolveSpectrumAccount({
      cfg: asConfig({
        channels: {
          "imessage-spectrum": {
            deliveryRetryCount: 100,
            deliveryRetryDelayMs: 10,
            deliveryQueueSize: 1000,
          },
        },
      }),
    });

    expect(account.deliveryRetryCount).toBe(10);
    expect(account.deliveryRetryDelayMs).toBe(250);
    expect(account.deliveryQueueSize).toBe(500);
  });

  it("clamps catchup settings to bounded production values", () => {
    const account = resolveSpectrumAccount({
      cfg: asConfig({
        channels: {
          "imessage-spectrum": {
            catchup: {
              lookbackCount: 500,
              intervalMs: 1000,
            },
          },
        },
      }),
    });

    expect(account.catchupLookbackCount).toBe(100);
    expect(account.catchupIntervalMs).toBe(5000);
  });

  it("keeps named account overrides separate from shared defaults", () => {
    const account = resolveSpectrumAccount({
      cfg: asConfig({
        channels: {
          "imessage-spectrum": {
            projectId: "base-project",
            projectSecret: "base-secret",
            webhookBaseUrl: "https://base.example.com",
            accounts: {
              support: {
                projectId: "support-project",
                webhookBaseUrl: "https://support.example.com/",
                enableSessionContext: false,
                sessionContext: "Support account context",
              },
            },
          },
        },
      }),
      accountId: "support",
    });

    expect(account.accountId).toBe("support");
    expect(account.projectId).toBe("support-project");
    expect(account.projectSecret).toBe("base-secret");
    expect(account.webhookBaseUrl).toBe("https://support.example.com");
    expect(account.enableSessionContext).toBe(false);
    expect(account.sessionContext).toBe("Support account context");
  });
});
