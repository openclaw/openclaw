import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/matrix";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAuth, resolveMatrixConfig } from "./client.js";

vi.mock("openclaw/plugin-sdk/matrix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/matrix")>();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(),
  };
});

vi.mock("./credentials.js", () => ({
  loadMatrixCredentials: vi.fn(() => null),
  saveMatrixCredentials: vi.fn(),
  credentialsMatchConfig: vi.fn(() => false),
  touchMatrixCredentials: vi.fn(),
}));

describe("resolveMatrixConfig", () => {
  it("prefers config over env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          userId: "@cfg:example.org",
          accessToken: "cfg-token",
          password: "cfg-pass",
          deviceName: "CfgDevice",
          initialSyncLimit: 5,
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://env.example.org",
      MATRIX_USER_ID: "@env:example.org",
      MATRIX_ACCESS_TOKEN: "env-token",
      MATRIX_PASSWORD: "env-pass",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;
    const resolved = resolveMatrixConfig(cfg, env);
    expect(resolved).toEqual({
      homeserver: "https://cfg.example.org",
      userId: "@cfg:example.org",
      accessToken: "cfg-token",
      password: "cfg-pass",
      deviceName: "CfgDevice",
      initialSyncLimit: 5,
      encryption: false,
    });
  });

  it("uses env when config is missing", () => {
    const cfg = {} as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://env.example.org",
      MATRIX_USER_ID: "@env:example.org",
      MATRIX_ACCESS_TOKEN: "env-token",
      MATRIX_PASSWORD: "env-pass",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;
    const resolved = resolveMatrixConfig(cfg, env);
    expect(resolved.homeserver).toBe("https://env.example.org");
    expect(resolved.userId).toBe("@env:example.org");
    expect(resolved.accessToken).toBe("env-token");
    expect(resolved.password).toBe("env-pass");
    expect(resolved.deviceName).toBe("EnvDevice");
    expect(resolved.initialSyncLimit).toBeUndefined();
    expect(resolved.encryption).toBe(false);
  });
});

describe("resolveMatrixAuth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("allowlists the configured homeserver hostname for password login", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: {
        ok: true,
        json: async () => ({
          access_token: "syt_token",
          user_id: "@clio:cloud-city.dev",
          device_id: "DEVICE123",
        }),
      } as Response,
      finalUrl: "https://matrix.cloud-city.dev/_matrix/client/v3/login",
      release: vi.fn().mockResolvedValue(undefined),
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.cloud-city.dev",
          userId: "@clio:cloud-city.dev",
          password: "clio-password",
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth.accessToken).toBe("syt_token");
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://matrix.cloud-city.dev/_matrix/client/v3/login",
        policy: { allowedHostnames: ["matrix.cloud-city.dev"] },
        auditContext: "matrix.login",
      }),
    );
  });
});
