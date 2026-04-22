/**
 * Unit tests for the Kudosity SMS channel plugin.
 *
 * Tests the channel configuration, outbound message sending,
 * and target resolution.
 */

import { describe, expect, it, vi } from "vitest";
import { kudositySmsPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { kudositySmsSetupWizard } from "./setup-surface.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Cast arbitrary test fixtures to `OpenClawConfig`.
 *
 * The real config type is a large discriminated union owned by core. Tests
 * only care about the handful of nested fields the kudosity-sms plugin reads,
 * so we use a focused unsafe cast helper rather than spelling out the full
 * shape everywhere. Going through `unknown` keeps `typescript/no-explicit-any`
 * happy while still documenting the intent.
 */
function asCfg(input: unknown): OpenClawConfig {
  return input as OpenClawConfig;
}

type SendTextCtx = Parameters<
  NonNullable<NonNullable<typeof kudositySmsPlugin.outbound>["sendText"]>
>[0];
type SendMediaCtx = Parameters<
  NonNullable<NonNullable<typeof kudositySmsPlugin.outbound>["sendMedia"]>
>[0];

/** Cast a partial outbound context literal to the concrete adapter parameter type. */
function asSendTextCtx(input: unknown): SendTextCtx {
  return input as SendTextCtx;
}
function asSendMediaCtx(input: unknown): SendMediaCtx {
  return input as SendMediaCtx;
}

// ─── Mock Setup ──────────────────────────────────────────────────────────────

// Mock the Kudosity API client
vi.mock("./kudosity-api.js", () => ({
  sendSMS: vi.fn(async () => ({
    id: "sms-response-123",
    recipient: "61478038915",
    recipient_country: "AU",
    sender: "61400000000",
    sender_country: "AU",
    message_ref: "openclaw-1709366400000",
    message: "Hello from the AI!",
    status: "pending",
    sms_count: "1",
    is_gsm: true,
    routed_via: "",
    track_links: false,
    direction: "OUT",
    created_at: "2026-03-02T06:12:52Z",
    updated_at: "2026-03-02T06:12:52Z",
  })),
}));

// Mock the runtime — must provide the logging.getChildLogger() chain
// that channel.ts uses for structured warnings (e.g. media URL redaction).
const mockWarn = vi.fn();
vi.mock("./runtime.js", () => ({
  getKudositySmsRuntime: vi.fn(() => ({
    logging: {
      getChildLogger: () => ({ warn: mockWarn }),
    },
  })),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("kudositySmsPlugin", () => {
  describe("metadata", () => {
    it("should have correct plugin id", () => {
      expect(kudositySmsPlugin.id).toBe("kudosity-sms");
    });

    it("should have correct meta", () => {
      expect(kudositySmsPlugin.meta.label).toBe("SMS Kudosity");
      expect(kudositySmsPlugin.meta.docsLabel).toBe("kudosity-sms");
    });

    it("should declare a stable selection order", () => {
      expect(kudositySmsPlugin.meta.order).toBe(90);
    });

    it("should declare direct chat type and SMS-appropriate capabilities", () => {
      expect(kudositySmsPlugin.capabilities.chatTypes).toEqual(["direct"]);
      expect(kudositySmsPlugin.capabilities.media).toBe(false);
      expect(kudositySmsPlugin.capabilities.reactions).toBe(false);
      expect(kudositySmsPlugin.capabilities.blockStreaming).toBe(true);
    });
  });

  describe("config adapter", () => {
    it("should list a single default account", () => {
      const ids = kudositySmsPlugin.config.listAccountIds(asCfg({}));
      expect(ids).toEqual(["default"]);
    });

    it("should resolve account from nested config keys", () => {
      const account = kudositySmsPlugin.config.resolveAccount(
        asCfg({
          channels: {
            "kudosity-sms": {
              apiKey: "my-api-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        }),
        "default",
      );

      expect(account.accountId).toBe("default");
      expect(account.apiKey).toBe("my-api-key");
      expect(account.sender).toBe("+61400000000");
    });

    it("should fall back to environment variables", () => {
      const originalApiKey = process.env.KUDOSITY_API_KEY;
      const originalSender = process.env.KUDOSITY_SENDER;

      process.env.KUDOSITY_API_KEY = "env-api-key";
      process.env.KUDOSITY_SENDER = "+61411111111";

      try {
        const account = kudositySmsPlugin.config.resolveAccount(asCfg({ channels: {} }), "default");
        expect(account.apiKey).toBe("env-api-key");
        expect(account.sender).toBe("+61411111111");
      } finally {
        process.env.KUDOSITY_API_KEY = originalApiKey;
        process.env.KUDOSITY_SENDER = originalSender;
      }
    });

    it("should prefer config keys over environment variables", () => {
      const originalApiKey = process.env.KUDOSITY_API_KEY;
      process.env.KUDOSITY_API_KEY = "env-key";

      try {
        const account = kudositySmsPlugin.config.resolveAccount(
          asCfg({
            channels: {
              "kudosity-sms": {
                apiKey: "config-key", // pragma: allowlist secret
                sender: "+61400000000",
              },
            },
          }),
          "default",
        );
        expect(account.apiKey).toBe("config-key");
      } finally {
        process.env.KUDOSITY_API_KEY = originalApiKey;
      }
    });

    it("should return empty strings when no config is set", () => {
      const originalApiKey = process.env.KUDOSITY_API_KEY;
      const originalSender = process.env.KUDOSITY_SENDER;
      delete process.env.KUDOSITY_API_KEY;
      delete process.env.KUDOSITY_SENDER;

      try {
        const account = kudositySmsPlugin.config.resolveAccount(asCfg({ channels: {} }), "default");
        expect(account.apiKey).toBe("");
        expect(account.sender).toBe("");
      } finally {
        process.env.KUDOSITY_API_KEY = originalApiKey;
        process.env.KUDOSITY_SENDER = originalSender;
      }
    });

    it("should return default account id", () => {
      const id = kudositySmsPlugin.config.defaultAccountId!(asCfg({}));
      expect(id).toBe("default");
    });

    it("should report configured when apiKey and sender are set", () => {
      const account = {
        accountId: "default",
        apiKey: "my-key", // pragma: allowlist secret
        sender: "+61400000000",
      };
      expect(kudositySmsPlugin.config.isConfigured!(account, asCfg({}))).toBe(true);
    });

    it("should report not configured when apiKey is missing", () => {
      const account = {
        accountId: "default",
        apiKey: "",
        sender: "+61400000000",
      };
      expect(kudositySmsPlugin.config.isConfigured!(account, asCfg({}))).toBe(false);
    });

    it("should report not configured when sender is missing", () => {
      const account = {
        accountId: "default",
        apiKey: "my-key", // pragma: allowlist secret
        sender: "",
      };
      expect(kudositySmsPlugin.config.isConfigured!(account, asCfg({}))).toBe(false);
    });

    it("should give reason when apiKey is missing", () => {
      const account = {
        accountId: "default",
        apiKey: "",
        sender: "+61400000000",
      };
      expect(kudositySmsPlugin.config.unconfiguredReason!(account, asCfg({}))).toBe(
        "Missing Kudosity API key",
      );
    });

    it("should give reason when sender is missing", () => {
      const account = {
        accountId: "default",
        apiKey: "my-key", // pragma: allowlist secret
        sender: "",
      };
      expect(kudositySmsPlugin.config.unconfiguredReason!(account, asCfg({}))).toBe(
        "Missing sender number",
      );
    });
  });

  describe("setup", () => {
    it("should wire the declarative setupWizard onto the plugin", () => {
      expect(kudositySmsPlugin.setupWizard).toBeDefined();
      expect(kudositySmsPlugin.setupWizard).toBe(kudositySmsSetupWizard);
      expect(kudositySmsSetupWizard.channel).toBe("kudosity-sms");
    });

    it("should report not configured when apiKey and sender are both missing", async () => {
      const originalApiKey = process.env.KUDOSITY_API_KEY;
      const originalSender = process.env.KUDOSITY_SENDER;
      delete process.env.KUDOSITY_API_KEY;
      delete process.env.KUDOSITY_SENDER;

      try {
        const configured = await kudositySmsSetupWizard.status.resolveConfigured({
          cfg: asCfg({ channels: {} }),
        });
        expect(configured).toBe(false);
      } finally {
        process.env.KUDOSITY_API_KEY = originalApiKey;
        process.env.KUDOSITY_SENDER = originalSender;
      }
    });

    it("should report configured when apiKey and sender are both set", async () => {
      const configured = await kudositySmsSetupWizard.status.resolveConfigured({
        cfg: asCfg({
          channels: {
            "kudosity-sms": {
              apiKey: "abc", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        }),
      });
      expect(configured).toBe(true);
    });

    it("should clear credentials and disable channel via disable()", () => {
      const next = kudositySmsSetupWizard.disable!(
        asCfg({
          channels: {
            "kudosity-sms": {
              apiKey: "abc", // pragma: allowlist secret
              sender: "+61400000000",
              enabled: true,
            },
          },
        }),
      ) as unknown as {
        channels: Record<string, { apiKey?: string; sender?: string; enabled?: boolean }>;
      };
      const section = next.channels["kudosity-sms"];
      expect(section.apiKey).toBeUndefined();
      expect(section.sender).toBeUndefined();
      expect(section.enabled).toBe(false);
    });
  });

  describe("outbound adapter", () => {
    it("should have an outbound adapter", () => {
      expect(kudositySmsPlugin.outbound).toBeDefined();
    });

    it("should have deliveryMode 'direct'", () => {
      expect(kudositySmsPlugin.outbound!.deliveryMode).toBe("direct");
    });

    it("should set textChunkLimit to 1600 (10 concat SMS segments)", () => {
      expect(kudositySmsPlugin.outbound!.textChunkLimit).toBe(1600);
    });

    describe("resolveTarget", () => {
      it("should normalize a clean E.164 number", () => {
        const result = kudositySmsPlugin.outbound!.resolveTarget!({
          to: "+61478038915",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.to).toBe("+61478038915");
        }
      });

      it("should strip formatting before validating", () => {
        const result = kudositySmsPlugin.outbound!.resolveTarget!({
          to: " +61 (478) 038-915 ",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.to).toBe("+61478038915");
        }
      });

      it("should reject empty input with an actionable error", () => {
        const result = kudositySmsPlugin.outbound!.resolveTarget!({ to: "" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("--to <phone_number_e164>");
        }
      });

      it("should reject non-E.164 input", () => {
        const result = kudositySmsPlugin.outbound!.resolveTarget!({
          to: "not-a-number",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("invalid phone number format");
        }
      });
    });

    describe("sendText", () => {
      it("should send a text message via the Kudosity API", async () => {
        const { sendSMS: mockSendSMS } = await import("./kudosity-api.js");

        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        const result = await kudositySmsPlugin.outbound!.sendText!(
          asSendTextCtx({
            cfg,
            to: "+61478038915",
            text: "Hello from the AI!",
            accountId: "default",
          }),
        );

        expect(result.channel).toBe("kudosity-sms");
        expect(result.messageId).toBe("sms-response-123");

        // Verify the API was called with correct params
        expect(mockSendSMS).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: "test-key", // pragma: allowlist secret
            sender: "+61400000000",
          }),
          expect.objectContaining({
            message: "Hello from the AI!",
            sender: "+61400000000",
            recipient: "+61478038915",
          }),
        );
      });

      it("should strip whitespace and formatting from phone numbers", async () => {
        const { sendSMS: mockSendSMS } = await import("./kudosity-api.js");

        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        await kudositySmsPlugin.outbound!.sendText!(
          asSendTextCtx({
            cfg,
            to: "+61 478 038 915",
            text: "test",
          }),
        );

        expect(mockSendSMS).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            recipient: "+61478038915",
          }),
        );
      });

      it("should throw for empty phone number", async () => {
        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        await expect(
          kudositySmsPlugin.outbound!.sendText!(
            asSendTextCtx({
              cfg,
              to: "",
              text: "test",
            }),
          ),
        ).rejects.toThrow("recipient phone number is required");
      });

      it("should throw for invalid phone number format", async () => {
        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        await expect(
          kudositySmsPlugin.outbound!.sendText!(
            asSendTextCtx({
              cfg,
              to: "not-a-number",
              text: "test",
            }),
          ),
        ).rejects.toThrow("invalid phone number format");
      });

      it("should normalize sender number with spaces and formatting", async () => {
        const { sendSMS: mockSendSMS } = await import("./kudosity-api.js");

        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61 400 000 000",
            },
          },
        };

        await kudositySmsPlugin.outbound!.sendText!(
          asSendTextCtx({
            cfg,
            to: "+61478038915",
            text: "test",
          }),
        );

        expect(mockSendSMS).toHaveBeenCalledWith(
          expect.objectContaining({
            sender: "+61400000000",
          }),
          expect.objectContaining({
            sender: "+61400000000",
          }),
        );
      });
    });

    describe("sendMedia", () => {
      it("should send text-only when media URL is provided", async () => {
        const { sendSMS: mockSendSMS } = await import("./kudosity-api.js");

        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        const result = await kudositySmsPlugin.outbound!.sendMedia!(
          asSendMediaCtx({
            cfg,
            to: "+61478038915",
            text: "Check this out!",
            mediaUrl: "https://example.com/image.png",
            accountId: "default",
          }),
        );

        expect(result.channel).toBe("kudosity-sms");
        expect(result.messageId).toBe("sms-response-123");

        // Should send the text, not the media URL
        expect(mockSendSMS).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: "test-key", // pragma: allowlist secret
          }),
          expect.objectContaining({
            message: "Check this out!",
            recipient: "+61478038915",
          }),
        );
      });

      it("should use fallback text when no caption is provided", async () => {
        const { sendSMS: mockSendSMS } = await import("./kudosity-api.js");

        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        await kudositySmsPlugin.outbound!.sendMedia!(
          asSendMediaCtx({
            cfg,
            to: "+61478038915",
            text: "",
            mediaUrl: "https://example.com/image.png",
          }),
        );

        expect(mockSendSMS).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            message: "The assistant sent a file that can't be delivered via SMS.",
          }),
        );
      });

      it("should warn when media URL is dropped", async () => {
        mockWarn.mockClear();

        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        await kudositySmsPlugin.outbound!.sendMedia!(
          asSendMediaCtx({
            cfg,
            to: "+61478038915",
            text: "caption",
            mediaUrl: "https://example.com/photo.jpg",
          }),
        );

        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining("media attachments are not supported via SMS"),
        );
      });

      it("should throw for empty phone number", async () => {
        const cfg = {
          channels: {
            "kudosity-sms": {
              apiKey: "test-key", // pragma: allowlist secret
              sender: "+61400000000",
            },
          },
        };

        await expect(
          kudositySmsPlugin.outbound!.sendMedia!(
            asSendMediaCtx({
              cfg,
              to: "",
              text: "test",
            }),
          ),
        ).rejects.toThrow("recipient phone number is required");
      });
    });
  });

  describe("defaults", () => {
    it("should have no debounce for SMS", () => {
      expect(kudositySmsPlugin.defaults?.queue?.debounceMs).toBe(0);
    });
  });

  describe("reload", () => {
    it("should watch kudosity-sms config prefix", () => {
      expect(kudositySmsPlugin.reload?.configPrefixes).toEqual(["channels.kudosity-sms"]);
    });
  });
});
