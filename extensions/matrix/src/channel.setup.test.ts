import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";

const verificationMocks = vi.hoisted(() => ({ bootstrapMatrixVerification: vi.fn() }));

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: verificationMocks.bootstrapMatrixVerification,
}));

import { matrixSetupPlugin } from "./channel.setup.js";
import { matrixConfigAdapter } from "./config-adapter.js";
import { runMatrixSetupBootstrapAfterConfigWrite } from "./setup-bootstrap.js";
import { matrixSetupAdapter } from "./setup-core.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";
function config(matrix: NonNullable<CoreConfig["channels"]>["matrix"]): CoreConfig {
  return { channels: { matrix } };
}

describe("matrix setup post-write bootstrap", () => {
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
  const encryptedDefaultCfg = config({ encryption: true });
  const defaultPasswordInput = {
    homeserver: "https://matrix.example.org",
    userId: "@flurry:example.org",
    password: "secret", // pragma: allowlist secret
  } as const;
  const runtime: RuntimeEnv = { log, error, exit };

  async function runBootstrap(
    input: Record<string, unknown> = defaultPasswordInput,
    previousCfg = encryptedDefaultCfg,
    accountId = "default",
  ) {
    const cfg = matrixSetupAdapter.applyAccountConfig({
      cfg: previousCfg,
      accountId,
      input,
    }) as CoreConfig;
    await runMatrixSetupBootstrapAfterConfigWrite({ previousCfg, cfg, accountId, runtime });
    return cfg;
  }

  function mockBootstrapResult(params: {
    success: boolean;
    backupVersion?: string | null;
    error?: string;
  }) {
    verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
      success: params.success,
      ...(params.error ? { error: params.error } : {}),
      verification: { backupVersion: params.backupVersion ?? null },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });
  }

  beforeEach(() => {
    verificationMocks.bootstrapMatrixVerification.mockReset();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    installMatrixTestRuntime();
  });

  it("uses the supplied scoped account environment for configured state", async () => {
    await withEnvAsync(
      { MATRIX_HOMESERVER: "https://ambient.example.org", MATRIX_ACCESS_TOKEN: "ambient-token" },
      async () => {
        await expect(
          matrixSetupPlugin.config.hasConfiguredStateAsync!({
            cfg: config({}),
            env: {
              MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
              MATRIX_OPS_ACCESS_TOKEN: "scoped-token",
            },
          }),
        ).resolves.toBe(true);
      },
    );
  });

  it.each([false, true])(
    "does not bootstrap existing accounts (encryption=%s)",
    async (encryption) => {
      const previousCfg = config({
        accounts: {
          flurry: {
            encryption,
            homeserver: "https://matrix.example.org",
            userId: "@flurry:example.org",
            accessToken: "token",
          },
        },
      });
      const input = {
        homeserver: "https://matrix.example.org",
        userId: "@flurry:example.org",
        accessToken: "new-token",
      };
      await runBootstrap(input, previousCfg, "flurry");

      expect(verificationMocks.bootstrapMatrixVerification).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("logs a warning when verification bootstrap fails", async () => {
    mockBootstrapResult({ success: false, error: "no room-key backup exists on the homeserver" });
    await runBootstrap();

    expect(error).toHaveBeenCalledWith(
      'Matrix verification bootstrap warning for "default": no room-key backup exists on the homeserver',
    );
  });

  it("bootstraps a newly added env-backed default account when encryption is already enabled", async () => {
    await withEnvAsync(
      {
        MATRIX_HOMESERVER: "https://matrix.example.org",
        MATRIX_ACCESS_TOKEN: "env-token",
      },
      async () => {
        mockBootstrapResult({ success: true, backupVersion: "9" });
        const cfg = await runBootstrap({ useEnv: true });

        expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
          accountId: "default",
          cfg,
        });
        expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
      },
    );
  });

  it("rejects default useEnv setup when no Matrix auth env vars are available", () => {
    return withEnv(
      {
        MATRIX_HOMESERVER: undefined,
        MATRIX_USER_ID: undefined,
        MATRIX_ACCESS_TOKEN: undefined,
        MATRIX_PASSWORD: undefined,
        MATRIX_DEFAULT_HOMESERVER: undefined,
        MATRIX_DEFAULT_USER_ID: undefined,
        MATRIX_DEFAULT_ACCESS_TOKEN: undefined,
        MATRIX_DEFAULT_PASSWORD: undefined,
      },
      () => {
        expect(
          matrixSetupAdapter.validateInput?.({
            cfg: {} as CoreConfig,
            accountId: "default",
            input: { useEnv: true },
          }),
        ).toContain("Set Matrix env vars for the default account");
      },
    );
  });

  it("clears allowPrivateNetwork and proxy when deleting the default Matrix account config", () => {
    const updated = matrixConfigAdapter.deleteAccount?.({
      cfg: config({
        homeserver: "http://localhost.localdomain:8008",
        network: { dangerouslyAllowPrivateNetwork: true },
        proxy: "http://127.0.0.1:7890",
        accounts: {
          ops: { enabled: true },
        },
      }),
      accountId: "default",
    }) as CoreConfig;

    expect(updated.channels?.matrix).toEqual({ accounts: { ops: { enabled: true } } });
  });
});
