import { describe, expect, it } from "vitest";
import { FeishuConfigSchema, FeishuGroupSchema } from "./config-schema.js";

function expectSchemaIssue(
  result: ReturnType<typeof FeishuConfigSchema.safeParse>,
  issuePath: string,
) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some((issue) => issue.path.join(".") === issuePath)).toBe(true);
  }
}

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    // requireMention has no schema-level default now — it is resolved at runtime
    // through shared channel group-policy resolution, with an open-group override
    // that defaults to false only when requireMention is otherwise unset.
    expect(result.requireMention).toBeUndefined();
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        default: {},
      },
    });

    expect(result.accounts?.default?.dmPolicy).toBeUndefined();
    expect(result.accounts?.default?.groupPolicy).toBeUndefined();
    expect(result.accounts?.default?.requireMention).toBeUndefined();
  });

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
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expectSchemaIssue(result, "encryptKey");
  });

  it("accepts top-level webhook mode with verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        default: {
          connectionMode: "webhook",
          appId: "cli_default",
          appSecret: "secret_default", // pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.default.verificationToken");
  });

  it("rejects account webhook mode without encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        default: {
          connectionMode: "webhook",
          verificationToken: "token_default",
          appId: "cli_default",
          appSecret: "secret_default", // pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.default.encryptKey");
  });

  it("accepts account webhook mode inheriting top-level verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      accounts: {
        default: {
          connectionMode: "webhook",
          appId: "cli_default",
          appSecret: "secret_default", // pragma: allowlist secret
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef verificationToken in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
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

describe("FeishuConfigSchema replyInThread", () => {
  it("accepts replyInThread at top level", () => {
    const result = FeishuConfigSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("defaults replyInThread to undefined when not set", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.replyInThread).toBeUndefined();
  });

  it("rejects invalid replyInThread value", () => {
    const result = FeishuConfigSchema.safeParse({ replyInThread: "always" });
    expect(result.success).toBe(false);
  });

  it("accepts replyInThread in group config", () => {
    const result = FeishuGroupSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("accepts replyInThread in account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        default: { replyInThread: "enabled" },
      },
    });
    expect(result.accounts?.default?.replyInThread).toBe("enabled");
  });
});

describe("FeishuConfigSchema optimization flags", () => {
  it("defaults top-level typingIndicator and resolveSenderNames to true", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.typingIndicator).toBe(true);
    expect(result.resolveSenderNames).toBe(true);
  });

  it("accepts account-level optimization flags", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        default: {
          typingIndicator: false,
          resolveSenderNames: false,
        },
      },
    });
    expect(result.accounts?.default?.typingIndicator).toBe(false);
    expect(result.accounts?.default?.resolveSenderNames).toBe(false);
  });
});

describe("FeishuConfigSchema actions", () => {
  it("accepts top-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      actions: { reactions: false },
    });
    expect(result.actions?.reactions).toBe(false);
  });

  it("accepts account-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        default: {
          actions: { reactions: false },
        },
      },
    });
    expect(result.accounts?.default?.actions?.reactions).toBe(false);
  });
});

describe("FeishuConfigSchema defaultAccount", () => {
  it("accepts defaultAccount when it matches an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts any account key when defaultAccount is omitted", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        "whatever-bot": { appId: "cli_whatever", appSecret: "secret_whatever" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects defaultAccount when it does not match an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        backup: { appId: "cli_backup", appSecret: "secret_backup" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "defaultAccount")).toBe(
        true,
      );
    }
  });
});
