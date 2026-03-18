// Authored by: cc (Claude Code) | 2026-03-18
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSmsConfig, resolveSmsConfig, SmsConfigSchema } from "./config.js";

describe("SmsConfigSchema", () => {
  it("applies defaults when no input is provided", () => {
    const cfg = SmsConfigSchema.parse({});
    expect(cfg.serve.port).toBe(3335);
    expect(cfg.serve.bind).toBe("127.0.0.1");
    expect(cfg.serve.path).toBe("/sms/webhook");
    expect(cfg.inboundPolicy).toBe("allowlist");
    expect(cfg.allowFrom).toEqual([]);
    expect(cfg.skipSignatureVerification).toBe(false);
  });

  it("accepts a valid full config", () => {
    const cfg = SmsConfigSchema.parse({
      fromNumber: "+15550001234",
      twilio: { accountSid: "AC123", authToken: "secret" },
      serve: { port: 3336, bind: "0.0.0.0", path: "/sms/hook" },
      publicUrl: "https://example.com/sms/hook",
      inboundPolicy: "open",
      allowFrom: ["+15550005678"],
      skipSignatureVerification: true,
    });
    expect(cfg.fromNumber).toBe("+15550001234");
    expect(cfg.twilio?.accountSid).toBe("AC123");
    expect(cfg.serve.port).toBe(3336);
    expect(cfg.inboundPolicy).toBe("open");
    expect(cfg.allowFrom).toEqual(["+15550005678"]);
    expect(cfg.skipSignatureVerification).toBe(true);
  });

  it("rejects invalid E.164 fromNumber", () => {
    expect(() => SmsConfigSchema.parse({ fromNumber: "not-a-number" })).toThrow();
  });

  it("rejects invalid inboundPolicy value", () => {
    expect(() => SmsConfigSchema.parse({ inboundPolicy: "disabled" })).toThrow();
  });

  it("rejects invalid E.164 in allowFrom", () => {
    expect(() => SmsConfigSchema.parse({ allowFrom: ["1234"] })).toThrow();
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(() => SmsConfigSchema.parse({ unknownField: true })).toThrow();
  });
});

describe("normalizeSmsConfig", () => {
  it("fills defaults for missing fields", () => {
    const cfg = normalizeSmsConfig({});
    expect(cfg.serve.port).toBe(3335);
    expect(cfg.inboundPolicy).toBe("allowlist");
  });

  it("merges serve overrides without clobbering defaults", () => {
    const cfg = normalizeSmsConfig({ serve: { port: 3400 } });
    expect(cfg.serve.port).toBe(3400);
    expect(cfg.serve.bind).toBe("127.0.0.1");
    expect(cfg.serve.path).toBe("/sms/webhook");
  });

  it("preserves allowFrom array", () => {
    const cfg = normalizeSmsConfig({ allowFrom: ["+15550001234"] });
    expect(cfg.allowFrom).toEqual(["+15550001234"]);
  });
});

describe("resolveSmsConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("falls back to env vars when credentials are missing from config", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tokenenv";
    const cfg = resolveSmsConfig({});
    expect(cfg.twilio?.accountSid).toBe("ACenv");
    expect(cfg.twilio?.authToken).toBe("tokenenv");
  });

  it("prefers config values over env vars", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tokenenv";
    const cfg = resolveSmsConfig({ twilio: { accountSid: "ACcfg", authToken: "tokencfg" } });
    expect(cfg.twilio?.accountSid).toBe("ACcfg");
    expect(cfg.twilio?.authToken).toBe("tokencfg");
  });

  it("leaves credentials undefined when neither config nor env provide them", () => {
    const cfg = resolveSmsConfig({});
    expect(cfg.twilio?.accountSid).toBeUndefined();
    expect(cfg.twilio?.authToken).toBeUndefined();
  });
});
