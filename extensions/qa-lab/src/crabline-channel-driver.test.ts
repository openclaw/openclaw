// Qa Lab tests cover Crabline channel-driver metadata behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  runQaCrablineChannelDriverSmoke,
  resolveQaCrablineChannelDriverSelection,
} from "./crabline-channel-driver.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

async function createFakeCrablineCli() {
  const outputDir = makeTempDir(tempDirs, "qa-fake-crabline-");
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
  if (process.env.QA_FAKE_CRABLINE_DOCTOR_FAIL) {
    process.stderr.write("provider telegram mock doctor failed");
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
  it("resolves the Telegram SDK-backed channel driver", async () => {
    const crablineBin = await createFakeCrablineCli();
    const selection = await resolveQaCrablineChannelDriverSelection({
      channel: "telegram",
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
        env: { ...process.env, OPENCLAW_QA_CRABLINE_BIN: crablineBin },
      }),
    ).resolves.toMatchObject({
      channel: "slack",
      channelDriver: "crabline",
    });
  });

  it("runs Crabline's Chat SDK provider doctor through the package CLI", async () => {
    const outputDir = makeTempDir(tempDirs, "qa-crabline-driver-");
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

  it("fails Crabline's Chat SDK provider doctor when the CLI reports a failure", async () => {
    const outputDir = makeTempDir(tempDirs, "qa-crabline-driver-");
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
              QA_FAKE_CRABLINE_DOCTOR_FAIL: "1",
            },
            outputDir,
          },
        ),
      ).rejects.toThrow("provider telegram mock doctor failed");
    } finally {
      // tempDirs cleanup covers outputDir and the fake CLI dir.
    }
  });

  it("defaults to Telegram and rejects channels not reported ready by Crabline", async () => {
    const crablineBin = await createFakeCrablineCli();
    const env = { ...process.env, OPENCLAW_QA_CRABLINE_BIN: crablineBin };
    await expect(resolveQaCrablineChannelDriverSelection({ env })).resolves.toEqual({
      capabilityMatrixPath: "crabline-channel-capability-matrix.json",
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: "crabline-channel-smoke.json",
    });
    await expect(
      resolveQaCrablineChannelDriverSelection({
        channel: "signal",
        env,
      }),
    ).rejects.toThrow("--channel must be one of");
  });
});
