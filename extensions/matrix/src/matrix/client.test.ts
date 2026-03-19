import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import {
  getMatrixScopedEnvVarNames,
  resolveImplicitMatrixAccountId,
  resolveMatrixConfig,
  resolveMatrixConfigForAccount,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  validateMatrixHomeserverUrl,
} from "./client/config.js";
import * as credentialsReadModule from "./credentials-read.js";
import * as sdkModule from "./sdk.js";

const saveMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const touchMatrixCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("./credentials-read.js", () => ({
  loadMatrixCredentials: vi.fn(() => null),
  credentialsMatchConfig: vi.fn(() => false),
}));

vi.mock("./credentials-write.runtime.js", () => ({
  saveMatrixCredentials: saveMatrixCredentialsMock,
  touchMatrixCredentials: touchMatrixCredentialsMock,
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
      deviceId: undefined,
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
      MATRIX_DEVICE_ID: "ENVDEVICE",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;
    const resolved = resolveMatrixConfig(cfg, env);
    expect(resolved.homeserver).toBe("https://env.example.org");
    expect(resolved.userId).toBe("@env:example.org");
    expect(resolved.accessToken).toBe("env-token");
    expect(resolved.password).toBe("env-pass");
    expect(resolved.deviceId).toBe("ENVDEVICE");
    expect(resolved.deviceName).toBe("EnvDevice");
    expect(resolved.initialSyncLimit).toBeUndefined();
    expect(resolved.encryption).toBe(false);
  });

  it("uses account-scoped env vars for non-default accounts before global env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://global.example.org",
      MATRIX_ACCESS_TOKEN: "global-token",
      MATRIX_OPS_HOMESERVER: "https://ops.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      MATRIX_OPS_DEVICE_NAME: "Ops Device",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.homeserver).toBe("https://ops.example.org");
    expect(resolved.accessToken).toBe("ops-token");
    expect(resolved.deviceName).toBe("Ops Device");
  });

  it("uses collision-free scoped env var names for normalized account ids", () => {
    expect(getMatrixScopedEnvVarNames("ops-prod").accessToken).toBe(
      "MATRIX_OPS_X2D_PROD_ACCESS_TOKEN",
    );
    expect(getMatrixScopedEnvVarNames("ops_prod").accessToken).toBe(
      "MATRIX_OPS_X5F_PROD_ACCESS_TOKEN",
    );
  });

  it("prefers channels.matrix.accounts.default over global env for the default account", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.gumadeiras.com",
              userId: "@pinguini:matrix.gumadeiras.com",
              password: "cfg-pass", // pragma: allowlist secret
              deviceName: "OpenClaw Gateway Pinguini",
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://env.example.org",
      MATRIX_USER_ID: "@env:example.org",
      MATRIX_PASSWORD: "env-pass",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixAuthContext({ cfg, env });
    expect(resolved.accountId).toBe("default");
    expect(resolved.resolved).toMatchObject({
      homeserver: "https://matrix.gumadeiras.com",
      userId: "@pinguini:matrix.gumadeiras.com",
      password: "cfg-pass",
      deviceName: "OpenClaw Gateway Pinguini",
      encryption: true,
    });
  });

  it("ignores typoed defaultAccount values that do not map to a real Matrix account", () => {
    const cfg = {
      channels: {
        matrix: {
          defaultAccount: "ops",
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as CoreConfig;

    expect(resolveImplicitMatrixAccountId(cfg, {} as NodeJS.ProcessEnv)).toBe("default");
    expect(resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv }).accountId).toBe(
      "default",
    );
  });

  it("requires explicit defaultAccount selection when multiple named Matrix accounts exist", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            assistant: {
              homeserver: "https://matrix.assistant.example.org",
              accessToken: "assistant-token",
            },
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveImplicitMatrixAccountId(cfg, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv })).toThrow(
      /channels\.matrix\.defaultAccount.*--account <id>/i,
    );
  });

  it("rejects explicit non-default account ids that are neither configured nor scoped in env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(() =>
      resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv, accountId: "typo" }),
    ).toThrow(/Matrix account "typo" is not configured/i);
  });

  it("allows explicit non-default account ids backed only by scoped env vars", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_HOMESERVER: "https://ops.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveMatrixAuthContext({ cfg, env, accountId: "ops" }).accountId).toBe("ops");
  });

  it("does not inherit the base deviceId for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          accessToken: "base-token",
          deviceId: "BASEDEVICE",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", {} as NodeJS.ProcessEnv);
    expect(resolved.deviceId).toBeUndefined();
  });

  it("does not inherit the base userId for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          userId: "@base:example.org",
          accessToken: "base-token",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", {} as NodeJS.ProcessEnv);
    expect(resolved.userId).toBe("");
  });

  it("does not inherit base or global auth secrets for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          accessToken: "base-token",
          password: "base-pass", // pragma: allowlist secret
          deviceId: "BASEDEVICE",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              password: "ops-pass", // pragma: allowlist secret
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_ACCESS_TOKEN: "global-token",
      MATRIX_PASSWORD: "global-pass",
      MATRIX_DEVICE_ID: "GLOBALDEVICE",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.accessToken).toBeUndefined();
    expect(resolved.password).toBe("ops-pass");
    expect(resolved.deviceId).toBeUndefined();
  });

  it("does not inherit a base password for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          password: "base-pass", // pragma: allowlist secret
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_PASSWORD: "global-pass",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.password).toBeUndefined();
  });

  it("rejects insecure public http Matrix homeservers", () => {
    expect(() => validateMatrixHomeserverUrl("http://matrix.example.org")).toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
    expect(validateMatrixHomeserverUrl("http://127.0.0.1:8008")).toBe("http://127.0.0.1:8008");
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
          password: "secret", // pragma: allowlist secret
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
      accountId: "default",
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
      expect.any(Object),
      "default",
    );
  });

  it("surfaces password login errors when account credentials are invalid", async () => {
    const doRequestSpy = vi.spyOn(sdkModule.MatrixClient.prototype, "doRequest");
    doRequestSpy.mockRejectedValueOnce(new Error("Invalid username or password"));

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    await expect(
      resolveMatrixAuth({
        cfg,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("Invalid username or password");

    expect(doRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/login",
      undefined,
      expect.objectContaining({
        type: "m.login.password",
      }),
    );
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("uses cached matching credentials when access token is not configured", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
    });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("rejects embedded credentials in Matrix homeserver URLs", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://user:pass@matrix.example.org",
          accessToken: "tok-123",
        },
      },
    } as CoreConfig;

    await expect(resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      "Matrix homeserver URL must not include embedded credentials",
    );
  });

  it("falls back to config deviceId when cached credentials are missing it", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth.deviceId).toBe("DEVICE123");
    expect(auth.accountId).toBe("default");
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      }),
      expect.any(Object),
      "default",
    );
  });

  it("resolves token-only non-default account userId from whoami instead of inheriting the base user", async () => {
    const doRequestSpy = vi.spyOn(sdkModule.MatrixClient.prototype, "doRequest").mockResolvedValue({
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          userId: "@base:example.org",
          homeserver: "https://matrix.example.org",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(doRequestSpy).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(auth.userId).toBe("@ops:example.org");
    expect(auth.deviceId).toBe("OPSDEVICE");
  });

  it("uses named-account password auth instead of inheriting the base access token", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue(null);
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(false);
    const doRequestSpy = vi.spyOn(sdkModule.MatrixClient.prototype, "doRequest").mockResolvedValue({
      access_token: "ops-token",
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "legacy-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              password: "ops-pass", // pragma: allowlist secret
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(doRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/login",
      undefined,
      expect.objectContaining({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@ops:example.org" },
        password: "ops-pass",
      }),
    );
    expect(auth).toMatchObject({
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
    });
  });

  it("resolves missing whoami identity fields for token auth", async () => {
    const doRequestSpy = vi.spyOn(sdkModule.MatrixClient.prototype, "doRequest").mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(doRequestSpy).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
  });

  it("uses config deviceId with cached credentials when token is loaded from cache", async () => {
    vi.mocked(credentialsReadModule.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          deviceId: "DEVICE123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
  });

  it("falls back to the sole configured account when no global homeserver is set", async () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              deviceId: "OPSDEVICE",
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth).toMatchObject({
      accountId: "ops",
      homeserver: "https://ops.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
      encryption: true,
    });
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://ops.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
        deviceId: "OPSDEVICE",
      }),
      expect.any(Object),
      "ops",
    );
  });
});
