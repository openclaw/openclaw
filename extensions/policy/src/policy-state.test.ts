import { describe, expect, it } from "vitest";
import { scanPolicyChannels } from "./policy-state.js";

describe("scanPolicyChannels", () => {
  it("ignores reserved channel config namespaces", () => {
    expect(
      scanPolicyChannels({
        channels: {
          defaults: {
            provider: "telegram",
          },
          modelByChannel: {
            telegram: "openai/gpt-5.5",
          },
          telegram: {
            enabled: true,
          },
        },
      }),
    ).toEqual([
      {
        enabled: true,
        id: "telegram",
        provider: "telegram",
        source: "oc://openclaw.config/channels/telegram",
      },
    ]);
  });

  it("does not treat channel arrays as channel config maps", () => {
    expect(
      scanPolicyChannels({
        channels: [{ enabled: true }],
      }),
    ).toEqual([]);
  });
});
