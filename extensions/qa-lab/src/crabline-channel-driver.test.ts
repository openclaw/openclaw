// Qa Lab tests cover Crabline channel-driver metadata behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("runs Crabline's Chat SDK provider doctor through the package CLI", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-crabline-driver-"));
    try {
      const result = await runQaCrablineChannelDriverSmoke(
        {
          capabilityMatrixPath: "crabline-channel-capability-matrix.json",
          channel: "telegram",
          channelDriver: "crabline",
          smokeArtifactPath: "crabline-channel-smoke.json",
        },
        {
          env: {
            ...process.env,
            TELEGRAM_BOT_TOKEN: "telegram-token",
          },
          outputDir,
        },
      );
      expect(result.capabilityReport).toMatchObject({
        result: {
          configured: [expect.objectContaining({ adapter: "telegram", platform: "telegram" })],
        },
      });
      expect(result.smoke).toMatchObject({
        result: {
          findings: [],
          ok: true,
        },
      });
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails Crabline's Chat SDK provider doctor when required env is unavailable", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-crabline-driver-"));
    try {
      await expect(
        runQaCrablineChannelDriverSmoke(
          {
            capabilityMatrixPath: "crabline-channel-capability-matrix.json",
            channel: "telegram",
            channelDriver: "crabline",
            smokeArtifactPath: "crabline-channel-smoke.json",
          },
          {
            env: {
              ...process.env,
              TELEGRAM_BOT_TOKEN: "",
            },
            outputDir,
          },
        ),
      ).rejects.toThrow("provider telegram missing env TELEGRAM_BOT_TOKEN");
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
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
