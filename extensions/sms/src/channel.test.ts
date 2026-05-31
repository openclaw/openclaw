import { describe, expect, it } from "vitest";
import { resolveSmsTextChunkLimit, smsPlugin } from "./channel.js";

describe("smsPlugin outbound", () => {
  it("declares an active text chunker and account-aware chunk limit", () => {
    expect(smsPlugin.configSchema).toBeDefined();
    expect(smsPlugin.outbound?.chunker?.("alpha beta", 6)).toEqual(["alpha", "beta"]);
    expect(
      resolveSmsTextChunkLimit({
        cfg: {
          channels: {
            sms: {
              accountSid: "AC123",
              authToken: "secret",
              fromNumber: "+15557654321",
              textChunkLimit: 42,
            },
          },
        },
      }),
    ).toBe(42);
    expect(
      resolveSmsTextChunkLimit({
        cfg: {
          channels: {
            sms: {
              defaultAccount: "support",
              accounts: {
                support: {
                  accountSid: "AC-support",
                  authToken: "support-token",
                  fromNumber: "+15551112222",
                  textChunkLimit: 700,
                },
              },
            },
          },
        },
      }),
    ).toBe(700);
  });
});
