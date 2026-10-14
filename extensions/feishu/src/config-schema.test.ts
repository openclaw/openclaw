import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
// Feishu tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { FeishuChannelConfigSchema, FeishuConfigSchema } from "./config-schema.js";

// The NEGATIVE webhook fixtures below spread these bases and add
// verificationToken separately so the GHSA-G353-MGV3-8PCJ opengrep pattern —
// which matches `connectionMode: "webhook"` next to `verificationToken` in
// one object literal (including via constant propagation) — does not flag the
// fixtures that prove the schema rejects them. Positive fixtures stay literal.
const topLevelWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_top",
  appSecret: "secret_top", // pragma: allowlist secret
};
const accountWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_main",
  appSecret: "secret_main", // pragma: allowlist secret
};

function expectSchemaIssue(
  result: ReturnType<typeof FeishuConfigSchema.safeParse>,
  issuePath: string,
) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(issuePath);
  }
}

describe("FeishuConfigSchema webhook validation", () => {
  it("normalizes legacy groupPolicy allowall to open", () => {
    const result = FeishuConfigSchema.parse({
      groupPolicy: "allowall",
    });

    expect(result.groupPolicy).toBe("open");
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expectSchemaIssue(result, "verificationToken");
  });

  it("rejects top-level webhook mode without encryptKey", () => {
    // topLevelWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      ...topLevelWebhookBase,
      verificationToken: "token_top",
    });

    expectSchemaIssue(result, "encryptKey");
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.verificationToken");
  });

  it("rejects account webhook mode without encryptKey", () => {
    // accountWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          ...accountWebhookBase,
          verificationToken: "token_main",
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.encryptKey");
  });

  it("accepts SecretRef encryptKey in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: {
        source: "env",
        provider: "default",
        id: "FEISHU_ENCRYPT_KEY",
      },
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("FeishuConfigSchema stickerSets", () => {
  const entry = { file_received: ["thumbs up", "赞", "👍"] };

  function expectCatalogValidation(value: Record<string, unknown>, accepted: boolean) {
    expect(FeishuConfigSchema.safeParse(value).success, "Zod validation").toBe(accepted);
    const result = validateJsonSchemaValue({
      schema: FeishuChannelConfigSchema.schema,
      cacheKey: "feishu-sticker-catalog-test",
      value,
      applyDefaults: true,
    });
    expect(result.ok, "exported JSON Schema validation").toBe(accepted);
    if (result.ok) {
      expect(result.value).toMatchObject(value);
    }
  }

  it("accepts bounded bot catalogs only at channel scope", () => {
    const stickerSets = {
      "bot-without-prefix": entry,
      ["a".repeat(128)]: Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [
          `file_${index}`.padEnd(512, "界"),
          Array.from({ length: 8 }, () => "赞".repeat(64)),
        ]),
      ),
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`bot_${index}`, {}])),
    };
    expectCatalogValidation({ stickerSets }, true);
    expect(FeishuConfigSchema.parse({ stickerSets }).stickerSets).toEqual(stickerSets);
    expect(FeishuConfigSchema.parse({}).stickerSets).toBeUndefined();
    expectCatalogValidation({ accounts: { work: { stickerSets } } }, false);
  });
});

describe("FeishuConfigSchema defaultAccount", () => {
  it("rejects defaultAccount when it does not match an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        backup: { appId: "cli_backup", appSecret: "secret_backup" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("defaultAccount");
    }
  });
});
