import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const loadMatrixCredentialsMock = vi.hoisted(() => vi.fn(() => null));
const saveMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const credentialsMatchConfigMock = vi.hoisted(() => vi.fn(() => false));
const touchMatrixCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/matrix", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/matrix")>(
    "openclaw/plugin-sdk/matrix",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../credentials.js", () => ({
  loadMatrixCredentials: loadMatrixCredentialsMock,
  saveMatrixCredentials: saveMatrixCredentialsMock,
  credentialsMatchConfig: credentialsMatchConfigMock,
  touchMatrixCredentials: touchMatrixCredentialsMock,
}));

import { resolveMatrixAuth, resolveMatrixLoginSsrFPolicy } from "./config.js";

describe("Matrix login SSRF policy", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    loadMatrixCredentialsMock.mockClear();
    saveMatrixCredentialsMock.mockClear();
    credentialsMatchConfigMock.mockClear();
    touchMatrixCredentialsMock.mockClear();
  });

  it("returns browser SSRF hostname exceptions for Matrix login", () => {
    expect(
      resolveMatrixLoginSsrFPolicy({
        browser: {
          ssrfPolicy: {
            allowedHostnames: ["matrix.example.test"],
          },
        },
      } as never),
    ).toEqual({
      allowedHostnames: ["matrix.example.test"],
    });
  });

  it("returns undefined when no browser SSRF policy is configured", () => {
    expect(resolveMatrixLoginSsrFPolicy({} as never)).toBeUndefined();
  });

  it("passes the browser SSRF policy into password login requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        ok: true,
        json: async () => ({
          access_token: "token-123",
          user_id: "@assistant:example.test",
        }),
      },
      release: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      resolveMatrixAuth({
        cfg: {
          browser: {
            ssrfPolicy: {
              dangerouslyAllowPrivateNetwork: false,
              allowedHostnames: ["matrix.example.test"],
            },
          },
          channels: {
            matrix: {
              homeserver: "https://matrix.example.test",
              userId: "@assistant:example.test",
              password: "hunter2",
            },
          },
        } as never,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).resolves.toMatchObject({
      homeserver: "https://matrix.example.test",
      userId: "@assistant:example.test",
      accessToken: "token-123",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://matrix.example.test/_matrix/client/v3/login",
        policy: {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["matrix.example.test"],
        },
        auditContext: "matrix.login",
      }),
    );
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://matrix.example.test",
        userId: "@assistant:example.test",
        accessToken: "token-123",
      }),
      expect.any(Object),
      undefined,
    );
  });
});
