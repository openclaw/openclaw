import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readJsonLines,
  writePackagedGatewayFixture,
} from "./gateway-child-command.test-support.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
const owners: ReturnType<typeof createQaGatewayChild>[] = [];

beforeEach(() => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
});

afterEach(async () => {
  try {
    for (const owner of owners.splice(0)) {
      await owner.stop();
    }
    await tempDirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("QA auth store handoff", () => {
  it.each([
    {
      launch: "packaged live",
      usePackagedPlugins: true,
      providerMode: "live-frontier" as const,
      authProfileIds: ["qa-live-openai-env"],
      handoffCommands: ["update", "gateway"],
    },
    {
      launch: "source mock",
      usePackagedPlugins: false,
      providerMode: "mock-openai" as const,
      authProfileIds: ["qa-mock-openai", "qa-mock-anthropic"],
      handoffCommands: ["gateway"],
    },
  ])("releases staged auth stores before $launch child maintenance", async (testCase) => {
    vi.stubEnv("OPENAI_API_KEY", "qa-synthetic-auth-handoff");
    const fixtureRoot = await tempDirs.makeTempDir("qa-live-auth-handoff-");
    const tempParentDir = path.join(fixtureRoot, "gateway-temp");
    const recordPath = path.join(fixtureRoot, "commands.jsonl");
    await mkdir(tempParentDir);
    const fixturePath = await writePackagedGatewayFixture(fixtureRoot);
    const owner = createQaGatewayChild();
    owners.push(owner);
    await expect(
      owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: [fixturePath],
          tempParentDir,
          usePackagedPlugins: testCase.usePackagedPlugins,
        },
        providerMode: testCase.providerMode,
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4",
        transportBaseUrl: "http://127.0.0.1:43123",
        runtimeEnvPatch: {
          QA_RECORD_PATH: recordPath,
          QA_ASSERT_AUTH_HANDOFF: "1",
        },
      }),
    ).rejects.toThrow("fixture gateway exit");
    const records = await readJsonLines(recordPath);
    expect(records.filter((record) => record.kind === "auth-handoff")).toEqual(
      testCase.handoffCommands.map((command) => ({ kind: "auth-handoff", command, leases: 0 })),
    );
    expect(records.at(-1)).toMatchObject({
      kind: "gateway",
      authProfileIds: testCase.authProfileIds,
    });
  });
});
