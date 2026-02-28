import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";

const mockSave = vi.fn();
const mockLoad = vi.fn().mockReturnValue(null);
const mockMatch = vi.fn().mockReturnValue(false);
const mockTouch = vi.fn();

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

vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: vi.fn(),
}));

vi.mock("@vector-im/matrix-bot-sdk", () => ({
  MatrixClient: class MockMatrixClient {},
}));

const mockFetchGuard = vi.fn();
vi.mock("openclaw/plugin-sdk", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => mockFetchGuard(...args),
}));

function mockGuardedResponse(response: {
  ok: boolean;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}) {
  mockFetchGuard.mockResolvedValue({
    response,
    release: vi.fn().mockResolvedValue(undefined),
  });
}

describe("resolveMatrixAuth — token-only auth path", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockLoad.mockReturnValue(null);
    mockMatch.mockReturnValue(false);
  });

  it("includes deviceId from whoami when saving credentials", async () => {
    mockGuardedResponse({
      ok: true,
      json: async () => ({
        user_id: "@bot:example.org",
        device_id: "TESTDEVICE123",
      }),
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

    expect(mockSave).toHaveBeenCalledOnce();
    const [savedCreds] = mockSave.mock.calls[0] as [Record<string, unknown>];
    expect(savedCreds).toEqual({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "test-token-123",
      deviceId: "TESTDEVICE123",
    });
  });

  it("returns correct userId from whoami in token-only auth", async () => {
    mockGuardedResponse({
      ok: true,
      json: async () => ({
        user_id: "@fetched:example.org",
        device_id: "DEV456",
      }),
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

  it("throws when whoami returns non-ok response", async () => {
    mockGuardedResponse({
      ok: false,
      text: async () => "M_UNKNOWN_TOKEN: Invalid access token",
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
      "Matrix whoami failed",
    );
  });
});
