import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verificationMocks = vi.hoisted(() => ({
  bootstrapMatrixVerification: vi.fn(),
}));

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: verificationMocks.bootstrapMatrixVerification,
}));

import { matrixPlugin } from "./channel.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

describe("matrix setup post-write bootstrap", () => {
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
  const runtime: RuntimeEnv = {
    log,
    error,
    exit,
  };

  beforeEach(() => {
    verificationMocks.bootstrapMatrixVerification.mockReset();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    setMatrixRuntime({
      state: {
        resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
      },
    } as PluginRuntime);
  });

  it("bootstraps verification for newly added encrypted accounts", async () => {
    const previousCfg = {
      channels: {
        matrix: {
          encryption: true,
        },
      },
    } as CoreConfig;
    const input = {
      homeserver: "https://matrix.example.org",
      userId: "@flurry:example.org",
      password: "secret", // pragma: allowlist secret
    };
    const nextCfg = matrixPlugin.setup!.applyAccountConfig({
      cfg: previousCfg,
      accountId: "default",
      input,
    }) as CoreConfig;
    verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
      success: true,
      verification: {
        backupVersion: "7",
      },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });

    await matrixPlugin.setup!.afterAccountConfigWritten?.({
      previousCfg,
      cfg: nextCfg,
      accountId: "default",
      input,
      runtime,
    });

    expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
      accountId: "default",
    });
    expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
    expect(log).toHaveBeenCalledWith('Matrix backup version for "default": 7');
    expect(error).not.toHaveBeenCalled();
  });

  it("does not bootstrap verification for already configured accounts", async () => {
    const previousCfg = {
      channels: {
        matrix: {
          accounts: {
            flurry: {
              encryption: true,
              homeserver: "https://matrix.example.org",
              userId: "@flurry:example.org",
              accessToken: "token",
            },
          },
        },
      },
    } as CoreConfig;
    const input = {
      homeserver: "https://matrix.example.org",
      userId: "@flurry:example.org",
      accessToken: "new-token",
    };
    const nextCfg = matrixPlugin.setup!.applyAccountConfig({
      cfg: previousCfg,
      accountId: "flurry",
      input,
    }) as CoreConfig;

    await matrixPlugin.setup!.afterAccountConfigWritten?.({
      previousCfg,
      cfg: nextCfg,
      accountId: "flurry",
      input,
      runtime,
    });

    expect(verificationMocks.bootstrapMatrixVerification).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a warning when verification bootstrap fails", async () => {
    const previousCfg = {
      channels: {
        matrix: {
          encryption: true,
        },
      },
    } as CoreConfig;
    const input = {
      homeserver: "https://matrix.example.org",
      userId: "@flurry:example.org",
      password: "secret", // pragma: allowlist secret
    };
    const nextCfg = matrixPlugin.setup!.applyAccountConfig({
      cfg: previousCfg,
      accountId: "default",
      input,
    }) as CoreConfig;
    verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
      success: false,
      error: "no room-key backup exists on the homeserver",
      verification: {
        backupVersion: null,
      },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });

    await matrixPlugin.setup!.afterAccountConfigWritten?.({
      previousCfg,
      cfg: nextCfg,
      accountId: "default",
      input,
      runtime,
    });

    expect(error).toHaveBeenCalledWith(
      'Matrix verification bootstrap warning for "default": no room-key backup exists on the homeserver',
    );
  });

  it("bootstraps a newly added env-backed default account when encryption is already enabled", async () => {
    const previousEnv = {
      MATRIX_HOMESERVER: process.env.MATRIX_HOMESERVER,
      MATRIX_ACCESS_TOKEN: process.env.MATRIX_ACCESS_TOKEN,
    };
    process.env.MATRIX_HOMESERVER = "https://matrix.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "env-token";
    try {
      const previousCfg = {
        channels: {
          matrix: {
            encryption: true,
          },
        },
      } as CoreConfig;
      const input = {
        useEnv: true,
      };
      const nextCfg = matrixPlugin.setup!.applyAccountConfig({
        cfg: previousCfg,
        accountId: "default",
        input,
      }) as CoreConfig;
      verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
        success: true,
        verification: {
          backupVersion: "9",
        },
        crossSigning: {},
        pendingVerifications: 0,
        cryptoBootstrap: null,
      });

      await matrixPlugin.setup!.afterAccountConfigWritten?.({
        previousCfg,
        cfg: nextCfg,
        accountId: "default",
        input,
        runtime,
      });

      expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
        accountId: "default",
      });
      expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("rejects default useEnv setup when no Matrix auth env vars are available", () => {
    const previousEnv = {
      MATRIX_HOMESERVER: process.env.MATRIX_HOMESERVER,
      MATRIX_USER_ID: process.env.MATRIX_USER_ID,
      MATRIX_ACCESS_TOKEN: process.env.MATRIX_ACCESS_TOKEN,
      MATRIX_PASSWORD: process.env.MATRIX_PASSWORD,
      MATRIX_DEFAULT_HOMESERVER: process.env.MATRIX_DEFAULT_HOMESERVER,
      MATRIX_DEFAULT_USER_ID: process.env.MATRIX_DEFAULT_USER_ID,
      MATRIX_DEFAULT_ACCESS_TOKEN: process.env.MATRIX_DEFAULT_ACCESS_TOKEN,
      MATRIX_DEFAULT_PASSWORD: process.env.MATRIX_DEFAULT_PASSWORD,
    };
    for (const key of Object.keys(previousEnv)) {
      delete process.env[key];
    }
    try {
      expect(
        matrixPlugin.setup!.validateInput?.({
          cfg: {} as CoreConfig,
          accountId: "default",
          input: { useEnv: true },
        }),
      ).toContain("Set Matrix env vars for the default account");
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
