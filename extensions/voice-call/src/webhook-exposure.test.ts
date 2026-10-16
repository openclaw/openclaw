// Voice Call tests cover webhook exposure plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isProviderUnreachableWebhookUrl,
  resolveWebhookExposureStatus,
} from "./webhook-exposure.js";

describe("webhook exposure host classification", () => {
  it.each(["http://[fd00::1]/voice/webhook", "http://[::ffff:127.0.0.1]/voice/webhook"])(
    "treats local/private webhook URL %s as provider-unreachable",
    (url) => {
      expect(isProviderUnreachableWebhookUrl(url)).toBe(true);
    },
  );

  it.each(["http://[::ffff:8.8.8.8]/voice/webhook", "https://fcloud.example/voice/webhook"])(
    "does not reject public webhook URL %s",
    (url) => {
      expect(isProviderUnreachableWebhookUrl(url)).toBe(false);
    },
  );
});

it("does not report a missing public webhook for outbound-only LiveKit", () => {
  expect(
    resolveWebhookExposureStatus({ provider: "livekit", inboundPolicy: "disabled" }),
  ).toMatchObject({
    ok: true,
    configured: true,
    message: expect.stringContaining("Outbound-only LiveKit"),
  });
  for (const provider of ["twilio", "telnyx", "plivo"]) {
    expect(resolveWebhookExposureStatus({ provider, inboundPolicy: "disabled" }).ok).toBe(false);
  }
  expect(resolveWebhookExposureStatus({ provider: "livekit", inboundPolicy: "allowlist" }).ok).toBe(
    false,
  );
});
