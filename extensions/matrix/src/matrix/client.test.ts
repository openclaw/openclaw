import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAuth, resolveMatrixConfig } from "./client.js";
import * as sdkModule from "./sdk.js";

const saveMatrixCredentialsMock = vi.fn();

vi.mock("./credentials.js", () => ({
  loadMatrixCredentials: vi.fn(() => null),
  saveMatrixCredentials: (...args: unknown[]) => saveMatrixCredentialsMock(...args),
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    saveMatrixCredentialsMock.mockReset();
  });

  it("uses the hardened client request path for password login and persists deviceId", async () => {
    const doRequestSpy = vi.spyOn(sdkModule.MatrixClient.prototype, "doRequest").mockResolvedValue({
      access_token: "tok-123",
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(doRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/login",
      undefined,
      expect.objectContaining({
        type: "m.login.password",
      }),
    );
    expect(auth).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      }),
    );
  });
});
