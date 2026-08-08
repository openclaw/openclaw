import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configPath: "",
  createRuntime: vi.fn(),
  register: vi.fn(),
}));

vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: () => ({
    createPrivateRoom: vi.fn(async () => "!room:test"),
    joinRoom: vi.fn(),
  }),
}));
vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: vi.fn(),
}));
vi.mock("./scenario-runtime-e2ee-cli-runtime.js", () => ({
  createMatrixQaCliE2eeSetupRuntime: vi.fn(),
  createMatrixQaCliGatewayRuntime: mocks.createRuntime,
}));
vi.mock("./scenario-runtime-e2ee-cli-shared.js", () => ({
  buildMatrixQaPluginActivationConfig: () => ({}),
  parseMatrixQaCliJson: vi.fn(),
  registerMatrixQaCliE2eeAccount: mocks.register,
  writeMatrixQaCliOutputArtifacts: vi.fn(),
}));
vi.mock("./scenario-runtime-e2ee-room.js", () => ({
  buildMatrixE2eeReplyArtifact: vi.fn(),
}));
vi.mock("./scenario-runtime-e2ee-shared.js", () => ({
  ensureMatrixQaE2eeOwnDeviceVerified: vi.fn(),
  requireMatrixQaE2eeOutputDir: () => "/tmp/output",
  requireMatrixQaGatewayConfigPath: () => mocks.configPath,
}));

import { runMatrixQaE2eeCliSetupThenGatewayReplyScenario } from "./scenario-runtime-e2ee-cli-gateway.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Matrix CLI setup gateway config transaction", () => {
  it("restores the exact Matrix config after CLI failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-cli-config-"));
    tempDirs.push(dir);
    mocks.configPath = path.join(dir, "openclaw.json");
    const original = {
      channels: {
        matrix: {
          accounts: {
            default: { enabled: true },
            sibling: { enabled: false },
          },
          defaultAccount: "default",
          unknownValidField: { keep: true },
        },
      },
    };
    await writeFile(mocks.configPath, `${JSON.stringify(original, null, 2)}\n`);
    mocks.register
      .mockResolvedValueOnce({
        accessToken: "gateway-token",
        deviceId: "GATEWAY",
        password: "gateway-password",
        userId: "@gateway:test",
      })
      .mockResolvedValueOnce({
        accessToken: "driver-token",
        deviceId: "DRIVER",
        password: "driver-password",
        userId: "@driver:test",
      });
    const cliError = new Error("CLI failed");
    const dispose = vi.fn(async () => undefined);
    mocks.createRuntime.mockResolvedValue({
      dispose,
      rootDir: dir,
      run: vi.fn(async () => {
        throw cliError;
      }),
    });
    const snapshots: Record<string, unknown>[] = [];
    const context = {
      baseUrl: "https://matrix.test",
      restartGatewayAfterStateMutation: vi.fn(async (mutate) => {
        await mutate({ stateDir: dir });
        snapshots.push(JSON.parse(await readFile(mocks.configPath, "utf8")));
      }),
      timeoutMs: 1_000,
      waitGatewayAccountReady: vi.fn(),
    } as any;

    await expect(runMatrixQaE2eeCliSetupThenGatewayReplyScenario(context)).rejects.toBe(cliError);

    expect(snapshots[0]).toMatchObject({
      channels: {
        matrix: {
          accounts: {
            default: { enabled: true },
            sibling: { enabled: false },
            "cli-setup-gateway": { enabled: true },
          },
          defaultAccount: "default",
          unknownValidField: { keep: true },
        },
      },
    });
    expect(snapshots.at(-1)).toEqual(original);
    expect(JSON.parse(await readFile(mocks.configPath, "utf8"))).toEqual(original);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
