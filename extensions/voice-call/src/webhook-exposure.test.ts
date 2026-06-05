// Voice Call tests cover webhook exposure plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isLocalOnlyWebhookHost,
  isProviderUnreachableWebhookUrl,
  providerRequiresPublicWebhook,
  resolveWebhookExposureStatus,
} from "./webhook-exposure.js";

describe("webhook exposure host classification", () => {
  it.each([
    "http://[::]:3334/voice/webhook",
    "http://[::1]:3334/voice/webhook",
    "http://[fc00::1]/voice/webhook",
    "http://[fd00::1]/voice/webhook",
    "http://[::ffff:127.0.0.1]/voice/webhook",
    "http://[::ffff:10.0.0.1]/voice/webhook",
    "http://[::ffff:192.168.0.1]/voice/webhook",
    "http://[::ffff:172.16.0.1]/voice/webhook",
    "http://[fe80::1]/voice/webhook",
  ])("treats local/private webhook URL %s as provider-unreachable", (url) => {
    expect(isProviderUnreachableWebhookUrl(url)).toBe(true);
  });

  it.each([
    "http://[::ffff:8.8.8.8]/voice/webhook",
    "https://voice.example.com/voice/webhook",
    "https://fcloud.example/voice/webhook",
  ])("does not reject public webhook URL %s", (url) => {
    expect(isProviderUnreachableWebhookUrl(url)).toBe(false);
  });

  it.each(["[::1]", "[fc00::1]", "[fd00::1]", "::ffff:7f00:1", "::ffff:a00:1", "[fe80::1]"])(
    "normalizes local/private URL hostnames like %s",
    (host) => {
      expect(isLocalOnlyWebhookHost(host)).toBe(true);
    },
  );
});

describe("providerRequiresPublicWebhook", () => {
  it("requires public webhooks only for carrier webhook-plane providers", () => {
    expect(providerRequiresPublicWebhook("twilio")).toBe(true);
    expect(providerRequiresPublicWebhook("telnyx")).toBe(true);
    expect(providerRequiresPublicWebhook("plivo")).toBe(true);
    expect(providerRequiresPublicWebhook("msteams")).toBe(false);
    expect(providerRequiresPublicWebhook("mock")).toBe(false);
  });
});

describe("resolveWebhookExposureStatus", () => {
  it("does not flag msteams for webhook exposure (uses the bridge listener)", () => {
    // Regression: a valid msteams config has no publicUrl/tunnel/tailscale, but
    // Teams receives calls over its own bridge WebSocket — setup/status must not
    // report it as needing public webhook exposure.
    const status = resolveWebhookExposureStatus({ provider: "msteams" });
    expect(status.ok).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.message).toMatch(/bridge WebSocket listener/i);
  });

  it("exempts the mock provider", () => {
    expect(resolveWebhookExposureStatus({ provider: "mock" }).ok).toBe(true);
  });

  it("still flags a webhook-plane provider with no exposure configured", () => {
    const status = resolveWebhookExposureStatus({ provider: "twilio" });
    expect(status.ok).toBe(false);
    expect(status.configured).toBe(false);
  });

  it("accepts a reachable public URL for a webhook-plane provider", () => {
    const status = resolveWebhookExposureStatus({
      provider: "twilio",
      publicUrl: "https://voice.example.com/voice/webhook",
    });
    expect(status.ok).toBe(true);
  });
});
