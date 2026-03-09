import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsMatchConfig: vi.fn(),
  ensureMatrixSdkInstalled: vi.fn(),
  ensureMatrixSdkLoggingConfigured: vi.fn(),
  getChildLogger: vi.fn(),
  getUserId: vi.fn(),
  loadMatrixCredentials: vi.fn(),
  loadMatrixSdk: vi.fn(),
  saveMatrixCredentials: vi.fn(),
  touchMatrixCredentials: vi.fn(),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      loadConfig: vi.fn(),
    },
    logging: {
      getChildLogger: mocks.getChildLogger,
    },
  }),
}));

vi.mock("../deps.js", () => ({
  ensureMatrixSdkInstalled: mocks.ensureMatrixSdkInstalled,
}));

vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: mocks.ensureMatrixSdkLoggingConfigured,
}));

vi.mock("../sdk-runtime.js", () => ({
  loadMatrixSdk: mocks.loadMatrixSdk,
}));

vi.mock("../credentials.js", () => ({
  credentialsMatchConfig: mocks.credentialsMatchConfig,
  loadMatrixCredentials: mocks.loadMatrixCredentials,
  saveMatrixCredentials: mocks.saveMatrixCredentials,
  touchMatrixCredentials: mocks.touchMatrixCredentials,
}));

const { resolveMatrixAuth } = await import("./config.js");

describe("resolveMatrixAuth", () => {
  beforeEach(() => {
    mocks.credentialsMatchConfig.mockReset();
    mocks.ensureMatrixSdkInstalled.mockReset();
    mocks.ensureMatrixSdkLoggingConfigured.mockReset();
    mocks.getChildLogger.mockReset();
    mocks.getUserId.mockReset();
    mocks.loadMatrixCredentials.mockReset();
    mocks.loadMatrixSdk.mockReset();
    mocks.saveMatrixCredentials.mockReset();
    mocks.touchMatrixCredentials.mockReset();

    mocks.credentialsMatchConfig.mockReturnValue(false);
    mocks.getChildLogger.mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    mocks.loadMatrixCredentials.mockReturnValue(null);
  });

  it("installs the matrix SDK before whoami when access token auth omits userId", async () => {
    const order: string[] = [];
    const env: NodeJS.ProcessEnv = {};

    class FakeMatrixClient {
      constructor(_homeserver: string, _accessToken: string) {}

      async getUserId() {
        return await mocks.getUserId();
      }
    }

    mocks.ensureMatrixSdkInstalled.mockImplementation(async () => {
      order.push("ensure");
    });
    mocks.loadMatrixSdk.mockImplementation(() => {
      order.push("load");
      return {
        MatrixClient: FakeMatrixClient,
      };
    });
    mocks.getUserId.mockResolvedValue("@lobster:example.com");

    const auth = await resolveMatrixAuth({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.com",
            accessToken: "tok",
          },
        },
      },
      env,
    });

    expect(order).toEqual(["ensure", "load"]);
    expect(mocks.ensureMatrixSdkInstalled).toHaveBeenCalledWith({
      log: expect.any(Function),
    });
    expect(mocks.ensureMatrixSdkLoggingConfigured).toHaveBeenCalledTimes(1);
    expect(mocks.saveMatrixCredentials).toHaveBeenCalledWith(
      {
        homeserver: "https://matrix.example.com",
        userId: "@lobster:example.com",
        accessToken: "tok",
      },
      env,
      undefined,
    );
    expect(auth).toMatchObject({
      homeserver: "https://matrix.example.com",
      userId: "@lobster:example.com",
      accessToken: "tok",
    });
  });
});
