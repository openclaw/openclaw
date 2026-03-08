import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";

const mockSave = vi.fn();
const mockLoad = vi.fn().mockReturnValue(null);
const mockMatch = vi.fn().mockReturnValue(false);
const mockTouch = vi.fn();

const { MatrixClientCtorMock, MockMatrixClient, getWhoAmIMock } = vi.hoisted(() => {
  const MatrixClientCtorMock = vi.fn();
  const getWhoAmIMock = vi.fn();

  class MockMatrixClient {
    constructor(...args: unknown[]) {
      MatrixClientCtorMock(...args);
    }

    getWhoAmI(...args: unknown[]) {
      return getWhoAmIMock(...args);
    }
  }

  return { MatrixClientCtorMock, MockMatrixClient, getWhoAmIMock };
});

vi.mock("../credentials.js", () => ({
  loadMatrixCredentials: (...args: unknown[]) => mockLoad(...args),
  saveMatrixCredentials: (...args: unknown[]) => mockSave(...args),
  credentialsMatchConfig: (...args: unknown[]) => mockMatch(...args),
  touchMatrixCredentials: (...args: unknown[]) => mockTouch(...args),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: { loadConfig: () => ({}) },
  }),
}));

vi.mock("../sdk-runtime.js", () => ({
  loadMatrixSdk: () => ({
    MatrixClient: MockMatrixClient,
  }),
}));

vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: vi.fn(),
}));

describe("resolveMatrixAuth token-only auth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockLoad.mockReturnValue(null);
    mockMatch.mockReturnValue(false);
  });

  it("saves deviceId from whoami when credentials are token-only", async () => {
    getWhoAmIMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "TESTDEVICE123",
    });

    const { resolveMatrixAuth } = await import("./config.js");

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "test-token-123",
        },
      },
    } as CoreConfig;

    await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(MatrixClientCtorMock).toHaveBeenCalledWith(
      "https://matrix.example.org",
      "test-token-123",
    );
    expect(mockSave).toHaveBeenCalledOnce();
    const [savedCreds] = mockSave.mock.calls[0] as [Record<string, unknown>];
    expect(savedCreds).toEqual({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "test-token-123",
      deviceId: "TESTDEVICE123",
    });
  });

  it("returns the userId from whoami in token-only auth", async () => {
    getWhoAmIMock.mockResolvedValue({
      user_id: "@fetched:example.org",
      device_id: "DEV456",
    });

    const { resolveMatrixAuth } = await import("./config.js");

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "test-token-123",
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth.userId).toBe("@fetched:example.org");
    expect(auth.homeserver).toBe("https://matrix.example.org");
    expect(auth.accessToken).toBe("test-token-123");
  });

  it("throws when whoami does not return a user_id", async () => {
    getWhoAmIMock.mockResolvedValue({
      device_id: "DEV456",
    });

    const { resolveMatrixAuth } = await import("./config.js");

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "bad-token",
        },
      },
    } as CoreConfig;

    await expect(resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      "Matrix whoami did not return a user_id",
    );
  });
});
