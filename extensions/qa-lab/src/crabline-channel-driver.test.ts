// Qa Lab tests cover Crabline channel-driver metadata behavior.
import { describe, expect, it } from "vitest";
import {
  buildQaCrablineChannelCapabilityMatrix,
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
      channelDriverId: "telegram-local-v1",
      channelLive: false,
      smokeArtifactPath: "crabline-channel-smoke.json",
    });
    expect(
      buildQaCrablineChannelCapabilityMatrix(selection!, [
        {
          capabilityId: "telegram.dm.text",
          channel: "telegram",
          driverId: "telegram-local-v1",
          notes: "Direct-message text turn with source-visible transcript assertions.",
          status: "covered",
        },
        {
          capabilityId: "slack.dm.text",
          channel: "slack",
          notes: "Planned local Slack upstream driver.",
          status: "planned",
        },
      ]),
    ).toMatchObject({
      source: "openclaw/crabline",
      channelDriver: "crabline",
      selectedChannel: "telegram",
      rows: expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "telegram.dm.text",
          channel: "telegram",
          driverId: "telegram-local-v1",
          status: "covered",
        }),
        expect.objectContaining({
          capabilityId: "slack.dm.text",
          channel: "slack",
          status: "planned",
        }),
      ]),
    });
  });

  it("runs Crabline's imported deterministic local driver smoke", async () => {
    await expect(
      runQaCrablineChannelDriverSmoke({
        capabilityMatrixPath: "crabline-channel-capability-matrix.json",
        channel: "telegram",
        channelDriver: "crabline",
        channelDriverId: "telegram-local-v1",
        channelLive: false,
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

  it("requires a supported channel when the driver is selected", () => {
    expect(() => resolveQaCrablineChannelDriverSelection({ channelDriver: "crabline" })).toThrow(
      "--channel is required",
    );
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
