// Rcs tests cover account config normalization.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listRcsAccountIds, resolveRcsAccount } from "./accounts.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveRcsAccount", () => {
  it("defaults and clamps text chunks to Twilio's message body limit", () => {
    expect(resolveRcsAccount({ channels: { rcs: { enabled: true } } }).textChunkLimit).toBe(1600);
    expect(
      resolveRcsAccount({
        channels: {
          rcs: {
            enabled: true,
            textChunkLimit: 3000,
          },
        },
      }).textChunkLimit,
    ).toBe(1600);
    expect(
      resolveRcsAccount({
        channels: {
          rcs: {
            enabled: true,
            textChunkLimit: "1700",
          },
        },
      }).textChunkLimit,
    ).toBe(1600);
  });

  it("ignores blank Twilio environment fallbacks when discovering accounts", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "  ");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_RCS_MESSAGING_SERVICE_SID", "\t");
    vi.stubEnv("TWILIO_RCS_SENDER_ID", "");

    expect(listRcsAccountIds({ channels: { rcs: { enabled: true } } })).toEqual([]);
  });
});
