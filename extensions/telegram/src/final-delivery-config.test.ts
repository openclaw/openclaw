import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import { prepareTelegramFinalDeliveryConfig } from "./final-delivery-config.js";

const admittedToken = "123456:admitted-sender";

describe("prepareTelegramFinalDeliveryConfig", () => {
  it("pins the admitted token when the account sender is unchanged", () => {
    const prepared = prepareTelegramFinalDeliveryConfig(
      { channels: { telegram: { enabled: true, botToken: admittedToken } } },
      "default",
      admittedToken,
    );

    expect(prepared.channels?.telegram?.accounts?.default).toMatchObject({
      botToken: admittedToken,
      tokenFile: undefined,
    });
  });

  it("refuses before send when the Telegram account token changed", () => {
    const message = "The Telegram reply sender changed during this turn; delivery was not started.";

    expect(() =>
      prepareTelegramFinalDeliveryConfig(
        { channels: { telegram: { enabled: true, botToken: "999999:replaced-sender" } } },
        "default",
        admittedToken,
      ),
    ).toThrow(PlatformMessageNotDispatchedError);
    expect(() =>
      prepareTelegramFinalDeliveryConfig(
        { channels: { telegram: { enabled: true, botToken: "999999:replaced-sender" } } },
        "default",
        admittedToken,
      ),
    ).toThrow(message);
  });
});
