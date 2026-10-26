import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verificationMocks = vi.hoisted(() => ({ bootstrapMatrixVerification: vi.fn() }));

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: verificationMocks.bootstrapMatrixVerification,
}));

import { matrixSetupPlugin } from "./channel.setup.js";
import { runMatrixSetupBootstrapAfterConfigWrite } from "./setup-bootstrap.js";
import { matrixSetupAdapter } from "./setup-core.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";
function config(matrix: NonNullable<CoreConfig["channels"]>["matrix"]): CoreConfig {
  return { channels: { matrix } };
}
const auth = { homeserver: "https://matrix.example.org", userId: "@flurry:example.org" };
const authEnv = { MATRIX_HOMESERVER: auth.homeserver, MATRIX_ACCESS_TOKEN: "env-token" };

describe("matrix setup post-write bootstrap", () => {
  const runtime = createRuntimeEnv();
  const { log, error, exit } = runtime;
  const encryptedDefaultCfg = config({ encryption: true });
  const defaultPasswordInput = {
    ...auth,
    password: "secret", // pragma: allowlist secret
  } as const;

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

  function mockBootstrapResult(
    success: boolean,
    details: { backupVersion?: string; error?: string },
  ) {
    verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
      success,
      ...(details.error ? { error: details.error } : {}),
      verification: { backupVersion: details.backupVersion ?? null },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });
  }

  beforeEach(() => {
    verificationMocks.bootstrapMatrixVerification.mockReset();
    vi.mocked(log).mockClear();
    vi.mocked(error).mockClear();
    vi.mocked(exit).mockClear();
    installMatrixTestRuntime();
  });

  it("uses the supplied scoped account environment for configured state", async () => {
    await withEnvAsync(
      { ...authEnv, MATRIX_HOMESERVER: "https://ambient.example.org" },
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
        accounts: { flurry: { ...auth, encryption, accessToken: "token" } },
      });
      await runBootstrap({ ...auth, accessToken: "new-token" }, previousCfg, "flurry");

      expect(verificationMocks.bootstrapMatrixVerification).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("logs a warning when verification bootstrap fails", async () => {
    mockBootstrapResult(false, { error: "no room-key backup exists on the homeserver" });
    await runBootstrap();

    expect(error).toHaveBeenCalledWith(
      'Matrix verification bootstrap warning for "default": no room-key backup exists on the homeserver',
    );
  });

  it("bootstraps a newly added env-backed default account when encryption is already enabled", async () => {
    await withEnvAsync(authEnv, async () => {
      mockBootstrapResult(true, { backupVersion: "9" });
      const cfg = await runBootstrap({ useEnv: true });

      expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
        accountId: "default",
        cfg,
      });
      expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
    });
  });

  it("rejects default useEnv setup when no Matrix auth env vars are available", () => {
    const emptyEnv = Object.fromEntries(
      ["MATRIX_", "MATRIX_DEFAULT_"].flatMap((prefix) =>
        ["HOMESERVER", "USER_ID", "ACCESS_TOKEN", "PASSWORD"].map((key) => [
          `${prefix}${key}`,
          undefined,
        ]),
      ),
    );
    withEnv(emptyEnv, () => {
      expect(
        matrixSetupAdapter.validateInput?.({
          cfg: {} as CoreConfig,
          accountId: "default",
          input: { useEnv: true },
        }),
      ).toContain("Set Matrix env vars for the default account");
    });
  });

  it("clears allowPrivateNetwork and proxy when deleting the default Matrix account config", () => {
    const updated = matrixSetupPlugin.config.deleteAccount?.({
      cfg: config({
        homeserver: "http://localhost.localdomain:8008",
        network: { dangerouslyAllowPrivateNetwork: true },
        proxy: "http://127.0.0.1:7890",
        accounts: { ops: { enabled: true } },
      }),
      accountId: "default",
    }) as CoreConfig;

    expect(updated.channels?.matrix).toEqual({ accounts: { ops: { enabled: true } } });
  });
});
