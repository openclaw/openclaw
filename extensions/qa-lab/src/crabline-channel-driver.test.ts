// Qa Lab tests cover Crabline channel-driver metadata behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runQaCrablineChannelDriverSmoke,
  resolveQaCrablineChannelDriverSelection,
} from "./crabline-channel-driver.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFakeCrablineCli() {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-fake-crabline-"));
  tempDirs.push(outputDir);
  const cliPath = path.join(outputDir, "fake-crabline.mjs");
  await fs.writeFile(
    cliPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.at(-1);
if (command === "providers") {
  process.stdout.write(JSON.stringify({
    configured: [{ adapter: "telegram", platform: "telegram" }],
    support: [
      { platform: "telegram", status: "ready" },
      { platform: "slack", status: "ready" },
      { platform: "loopback", status: "ready" }
    ]
  }));
} else if (command === "doctor") {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    process.stderr.write("provider telegram missing telegram.botToken or TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ findings: [], ok: true }));
} else {
  process.stderr.write("unexpected command " + command);
  process.exit(1);
}
`,
    "utf8",
  );
  return cliPath;
}

describe("crabline channel driver metadata", () => {
  it("returns null when no channel driver is selected", async () => {
    await expect(resolveQaCrablineChannelDriverSelection({})).resolves.toBeNull();
  });

  it("resolves the Telegram SDK-backed channel driver", async () => {
    const crablineBin = await createFakeCrablineCli();
    const selection = await resolveQaCrablineChannelDriverSelection({
      channel: "telegram",
      channelDriver: "crabline",
      env: { ...process.env, OPENCLAW_QA_CRABLINE_BIN: crablineBin },
    });

    expect(selection).toEqual({
      capabilityMatrixPath: "crabline-channel-capability-matrix.json",
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: "crabline-channel-smoke.json",
    });
  });

  it("accepts channels reported ready by Crabline", async () => {
    const crablineBin = await createFakeCrablineCli();
    await expect(
      resolveQaCrablineChannelDriverSelection({
        channel: "slack",
        channelDriver: "crabline",
        env: { ...process.env, OPENCLAW_QA_CRABLINE_BIN: crablineBin },
      }),
    ).resolves.toMatchObject({
      channel: "slack",
      channelDriver: "crabline",
    });
  });

  it("runs Crabline's Chat SDK provider doctor through the package CLI", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-crabline-driver-"));
    tempDirs.push(outputDir);
    const crablineBin = await createFakeCrablineCli();
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
            OPENCLAW_QA_CRABLINE_BIN: crablineBin,
            OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "telegram-token",
            TELEGRAM_BOT_TOKEN: "",
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
      // tempDirs cleanup covers outputDir and the fake CLI dir.
    }
  });

  it("fails Crabline's Chat SDK provider doctor when required env is unavailable", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-crabline-driver-"));
    tempDirs.push(outputDir);
    const crablineBin = await createFakeCrablineCli();
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
              OPENCLAW_QA_CRABLINE_BIN: crablineBin,
              TELEGRAM_BOT_TOKEN: "",
            },
            outputDir,
          },
        ),
      ).rejects.toThrow("provider telegram missing telegram.botToken or TELEGRAM_BOT_TOKEN");
    } finally {
      // tempDirs cleanup covers outputDir and the fake CLI dir.
    }
  });

  it("defaults to Telegram and rejects channels not reported ready by Crabline", async () => {
    const crablineBin = await createFakeCrablineCli();
    const env = { ...process.env, OPENCLAW_QA_CRABLINE_BIN: crablineBin };
    await expect(
      resolveQaCrablineChannelDriverSelection({ channelDriver: "crabline", env }),
    ).resolves.toEqual({
      capabilityMatrixPath: "crabline-channel-capability-matrix.json",
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: "crabline-channel-smoke.json",
    });
    await expect(
      resolveQaCrablineChannelDriverSelection({
        channel: "signal",
        channelDriver: "crabline",
        env,
      }),
    ).rejects.toThrow("--channel must be one of");
  });

  it("rejects channel identity without a channel driver", async () => {
    await expect(resolveQaCrablineChannelDriverSelection({ channel: "telegram" })).rejects.toThrow(
      "--channel requires --channel-driver crabline",
    );
  });
});
