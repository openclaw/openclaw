import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import {
  createRuntimeEnv,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verificationMocks = vi.hoisted(() => ({ bootstrapMatrixVerification: vi.fn() }));

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: verificationMocks.bootstrapMatrixVerification,
}));
const bootstrap = verificationMocks.bootstrapMatrixVerification;

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

it("compares Matrix command owners as case-sensitive sender identities", async ({
  onTestFinished,
}) => {
  const registry = createTestRegistry([
    { pluginId: "matrix", plugin: matrixSetupPlugin, source: "test" },
  ]);
  onTestFinished(() => resetPluginRuntimeStateForTest());
  setActivePluginRegistry(registry);
  const sender = "@Alice:Example.org";
  for (const entry of [sender, `matrix:${sender}`, `user:${sender}`, `matrix:user:${sender}`]) {
    const result = await resolveCommandAuthorizationAsync({
      cfg: { commands: { ownerAllowFrom: [entry] } },
      ctx: { Provider: "matrix", SenderId: sender, ChatType: "group" },
      commandAuthorized: true,
    });
    expect(result, entry).toMatchObject({
      ownerList: [sender],
      senderIsOwner: true,
      isAuthorizedSender: true,
    });
  }
  for (const entry of [
    "user:@alice:Example.org",
    "user:@Alice:example.org",
    "user:@Bob:Example.org",
    "room:!room:Example.org",
    "discord:user:@Alice:Example.org",
    "*",
  ]) {
    const result = await resolveCommandAuthorizationAsync({
      cfg: {
        commands: { ownerAllowFrom: [entry], allowFrom: { matrix: ["user:@Bob:Example.org"] } },
      },
      ctx: {
        Provider: "matrix",
        SenderId: sender,
        From: "matrix:room:!room:Example.org",
        ChatType: "group",
      },
      commandAuthorized: true,
    });
    expect(result, entry).toMatchObject({ senderIsOwner: false, isAuthorizedSender: false });
  }
});

describe("matrix setup post-write bootstrap", () => {
  const runtime = createRuntimeEnv();
  const { log, error } = runtime;

  async function runBootstrap(
    input: Record<string, unknown>,
    previousCfg = config({ encryption: true }),
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

  beforeEach(() => {
    bootstrap.mockReset();
    vi.mocked(log).mockClear();
    vi.mocked(error).mockClear();
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

  it.each([false, true])("leaves existing accounts alone (encryption=%s)", async (encryption) => {
    const previousCfg = config({
      accounts: { flurry: { ...auth, encryption, accessToken: "token" } },
    });
    await runBootstrap({ ...auth, accessToken: "new-token" }, previousCfg, "flurry");

    expect(bootstrap).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports bootstrap success=%s", async (success) => {
    await withEnvAsync(authEnv, async () => {
      const warning = "no room-key backup exists on the homeserver";
      bootstrap.mockResolvedValue({
        success,
        error: warning,
        verification: { backupVersion: "9" },
      });
      const cfg = await runBootstrap(success ? { useEnv: true } : { ...auth, password: "secret" }); // pragma: allowlist secret
      expect(bootstrap).toHaveBeenCalledWith({ accountId: "default", cfg });
      expect(success ? log : error).toHaveBeenCalledWith(
        success
          ? 'Matrix verification bootstrap: complete for "default".'
          : `Matrix verification bootstrap warning for "default": ${warning}`,
      );
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
