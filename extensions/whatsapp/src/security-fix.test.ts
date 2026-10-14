import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

import { applyWhatsAppSecurityConfigFixes } from "./security-fix.js";

describe("applyWhatsAppSecurityConfigFixes", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue(["+15550000001"]);
  });

  it("seeds only holders whose open group policy is awaiting conversion", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          accounts: {
            default: { groupPolicy: "open" },
            alreadyRestricted: { groupPolicy: "allowlist" },
            disabled: { groupPolicy: "disabled" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applyWhatsAppSecurityConfigFixes({ cfg, env: process.env });

    expect(result.changes).toEqual([
      "channels.whatsapp.groupAllowFrom=pairing-store",
      "channels.whatsapp.accounts.default.groupAllowFrom=pairing-store",
    ]);
    expect(result.config.channels?.whatsapp?.groupAllowFrom).toEqual(["+15550000001"]);
    expect(result.config.channels?.whatsapp?.accounts?.default?.groupAllowFrom).toEqual([
      "+15550000001",
    ]);
    expect(
      result.config.channels?.whatsapp?.accounts?.alreadyRestricted?.groupAllowFrom,
    ).toBeUndefined();
    expect(result.config.channels?.whatsapp?.accounts?.disabled?.groupAllowFrom).toBeUndefined();
  });

  it("does not modify an existing empty allowlist", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          accounts: {
            default: { groupPolicy: "allowlist" },
            work: { groupPolicy: "allowlist" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applyWhatsAppSecurityConfigFixes({ cfg, env: process.env });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("preserves explicit allowlists while an open policy is converted", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          allowFrom: ["+15550000002"],
          accounts: {
            work: { groupPolicy: "open", groupAllowFrom: ["+15550000003"] },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applyWhatsAppSecurityConfigFixes({ cfg, env: process.env });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });
});
