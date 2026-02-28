import { describe, expect, it } from "vitest";
import { FeishuConfigSchema, FeishuGroupSchema } from "./config-schema.js";

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    expect(result.requireMention).toBe(true);
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {},
      },
    });

    expect(result.accounts?.main?.dmPolicy).toBeUndefined();
    expect(result.accounts?.main?.groupPolicy).toBeUndefined();
    expect(result.accounts?.main?.requireMention).toBeUndefined();
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      appId: "cli_top",
      appSecret: "secret_top",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "verificationToken"),
      ).toBe(true);
    }
  });

  it("accepts top-level webhook mode with verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      appId: "cli_top",
      appSecret: "secret_top",
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main",
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join(".") === "accounts.main.verificationToken",
        ),
      ).toBe(true);
    }
  });

  it("accepts account webhook mode inheriting top-level verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      verificationToken: "token_top",
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main",
        },
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
        main: { replyInThread: "enabled" },
      },
    });
    expect(result.accounts?.main?.replyInThread).toBe("enabled");
  });
});
