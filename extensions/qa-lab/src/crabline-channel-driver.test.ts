// Qa Lab tests cover Crabline channel-driver metadata behavior.
import { describe, expect, it } from "vitest";
import {
  runQaCrablineChannelDriverSmoke,
  resolveQaCrablineChannelDriverSelection,
} from "./crabline-channel-driver.js";

describe("crabline channel driver metadata", () => {
  it("returns null when no channel driver is selected", () => {
    expect(resolveQaCrablineChannelDriverSelection({})).toBeNull();
  });

  it("resolves the Telegram SDK-backed channel driver", () => {
    const selection = resolveQaCrablineChannelDriverSelection({
      channel: "telegram",
      channelDriver: "crabline",
    });

    expect(selection).toEqual({
      capabilityMatrixPath: "crabline-channel-capability-matrix.json",
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: "crabline-channel-smoke.json",
    });
  });

  it("runs Crabline's imported deterministic local driver smoke", async () => {
    await expect(
      runQaCrablineChannelDriverSmoke({
        capabilityMatrixPath: "crabline-channel-capability-matrix.json",
        channel: "telegram",
        channelDriver: "crabline",
        smokeArtifactPath: "crabline-channel-smoke.json",
      }),
    ).resolves.toMatchObject({
      driver: {
        channel: "telegram",
        driverId: "telegram-local-v1",
      },
      result: {
        ok: true,
        providerId: "telegram-local",
      },
    });
  });

  it("defaults to Telegram and rejects unsupported channels when the driver is selected", () => {
    expect(resolveQaCrablineChannelDriverSelection({ channelDriver: "crabline" })).toEqual({
      capabilityMatrixPath: "crabline-channel-capability-matrix.json",
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: "crabline-channel-smoke.json",
    });
    expect(() =>
      resolveQaCrablineChannelDriverSelection({
        channel: "slack",
        channelDriver: "crabline",
      }),
    ).toThrow("--channel must be one of telegram");
  });

  it("rejects channel identity without a channel driver", () => {
    expect(() => resolveQaCrablineChannelDriverSelection({ channel: "telegram" })).toThrow(
      "--channel requires --channel-driver crabline",
    );
  });
});
