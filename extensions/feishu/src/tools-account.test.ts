import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveToolClient } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuDocSchema } from "./doc-schema.js";
import { FeishuDriveSchema } from "./drive-schema.js";
import { FeishuPermSchema } from "./perm-schema.js";
import { FeishuWikiSchema } from "./wiki-schema.js";

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({ __mocked: true })),
}));

function makeConfig(feishu: Record<string, unknown>): ClawdbotConfig {
  return { channels: { feishu } } as unknown as ClawdbotConfig;
}

describe("resolveToolClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves explicit account credentials", () => {
    const cfg = makeConfig({
      domain: "feishu",
      accounts: {
        secondary: {
          appId: "secondary_id",
          appSecret: "secondary_secret",
        },
      },
    });

    const result = resolveToolClient(cfg, "secondary");
    expect(result.accountId).toBe("secondary");
    expect(result.account).toBeDefined();
    expect(createFeishuClient).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "secondary",
        appId: "secondary_id",
        appSecret: "secondary_secret",
      }),
    );
  });

  it("falls back to first enabled account when account is omitted", () => {
    const cfg = makeConfig({
      appId: "default_id",
      appSecret: "default_secret",
      domain: "feishu",
    });

    const result = resolveToolClient(cfg);
    expect(result.accountId).toBe("default");
    expect(result.account).toBeDefined();
    expect(result.client).toBeDefined();
  });

  it("uses default account when no accounts field is configured", () => {
    const cfg = makeConfig({
      appId: "top_level_id",
      appSecret: "top_level_secret",
      domain: "feishu",
    });

    const result = resolveToolClient(cfg);
    expect(result.accountId).toBe("default");
    expect(result.account).toBeDefined();
    expect(createFeishuClient).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        appId: "top_level_id",
        appSecret: "top_level_secret",
      }),
    );
  });

  it("uses preferred account when account param is omitted", () => {
    const cfg = makeConfig({
      domain: "feishu",
      accounts: {
        app2: { appId: "app2_id", appSecret: "app2_secret" },
        shixiaoheng: { appId: "sxh_id", appSecret: "sxh_secret" },
      },
    });

    const result = resolveToolClient(cfg, undefined, "shixiaoheng");
    expect(result.accountId).toBe("shixiaoheng");
  });

  it("throws for unconfigured account", () => {
    const cfg = makeConfig({
      domain: "feishu",
      accounts: {
        primary: {
          appId: "primary_id",
          appSecret: "primary_secret",
        },
      },
    });

    expect(() => resolveToolClient(cfg, "nonexistent")).toThrow(
      'Feishu account "nonexistent" is not configured',
    );
  });

  it("throws for disabled account", () => {
    const cfg = makeConfig({
      domain: "feishu",
      accounts: {
        disabled_acct: {
          appId: "disabled_id",
          appSecret: "disabled_secret",
          enabled: false,
        },
      },
    });

    expect(() => resolveToolClient(cfg, "disabled_acct")).toThrow(
      'Feishu account "disabled_acct" is disabled',
    );
  });

  it("throws when no accounts are configured", () => {
    const cfg = makeConfig({});
    expect(() => resolveToolClient(cfg)).toThrow("No Feishu accounts configured");
  });
});

describe("tool schemas include optional account field", () => {
  const schemas = [
    { name: "FeishuDocSchema", schema: FeishuDocSchema },
    { name: "FeishuWikiSchema", schema: FeishuWikiSchema },
    { name: "FeishuDriveSchema", schema: FeishuDriveSchema },
    { name: "FeishuPermSchema", schema: FeishuPermSchema },
  ];

  for (const { name, schema } of schemas) {
    it(`${name}: all variants include optional account field`, () => {
      for (const variant of schema.anyOf) {
        expect(variant.properties).toHaveProperty("account");
        expect((variant.required ?? []) as string[]).not.toContain("account");
      }
    });
  }
});
