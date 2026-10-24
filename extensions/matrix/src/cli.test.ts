import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCli } from "./cli.js";
import { mockCallArg } from "./cli.test-support.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  backupStatus: vi.fn(),
  verificationStatus: vi.fn(),
  devices: vi.fn(),
  verifications: vi.fn(),
  request: vi.fn(),
  accountConfig: vi.fn(),
  account: vi.fn(),
  authContext: vi.fn(),
  applyAccountConfig: vi.fn(),
  validateInput: vi.fn(),
  loadConfig: vi.fn(),
  mutateConfig: vi.fn(),
  replaceConfig: vi.fn(),
  resetBackup: vi.fn(),
  restoreBackup: vi.fn(),
  selfVerify: vi.fn(),
  profile: vi.fn(),
  verifyKey: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  stdout: vi.fn(),
}));

function expectLogs(...messages: string[]): void {
  for (const message of messages) {
    expect(mocks.log).toHaveBeenCalledWith(message);
  }
}

function expectFailure(message: string) {
  expect(process.exitCode).toBe(1);
  expect(mocks.error).toHaveBeenCalledWith(message);
}

function setStatus(overrides: Record<string, unknown> = {}) {
  const status = matrixVerificationStatus(overrides);
  mocks.verificationStatus.mockResolvedValue(status);
  return status;
}

function expectCall(mock: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(mockCallArg(mock)).toMatchObject(fields);
}

function jsonOutput(index = -1) {
  return JSON.parse(String(mockCallArg(mocks.stdout, index)));
}

function holdResult(mock: ReturnType<typeof vi.fn<() => Promise<unknown>>>, result: unknown) {
  const entered = createDeferred<void>(),
    retired = createDeferred<void>();
  mock.mockImplementationOnce(async () => {
    entered.resolve();
    await retired.promise;
    return result;
  });
  return { entered: entered.promise, release: () => retired.resolve() };
}

function configureAccount(encryption = false) {
  const account = { encryption, homeserver: "https://matrix.example.org", accessToken: "token" };
  const cfg = { channels: { matrix: { enabled: true, accounts: { ops: account } } } };
  mocks.loadConfig.mockReturnValue(cfg);
  mocks.account.mockReturnValue({ configured: true, enabled: true, config: account });
  mocks.accountConfig.mockImplementation(readAccountConfig);
  return cfg;
}

function mockRecoveryKeyStdin(...values: string[]): void {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockReturnValue(
    (async function* (): AsyncGenerator<Buffer, undefined, unknown> {
      for (const value of values) {
        yield Buffer.from(value);
      }
      return undefined;
    })(),
  );
}

vi.mock("./matrix/actions/verification.js", () => ({
  acceptMatrixVerification: vi.fn(),
  bootstrapMatrixVerification: mocks.bootstrap,
  cancelMatrixVerification: vi.fn(),
  confirmMatrixVerificationSas: vi.fn(),
  getMatrixRoomKeyBackupStatus: mocks.backupStatus,
  getMatrixVerificationSas: vi.fn(),
  getMatrixVerificationStatus: mocks.verificationStatus,
  listMatrixVerifications: mocks.verifications,
  mismatchMatrixVerificationSas: vi.fn(),
  requestMatrixVerification: mocks.request,
  resetMatrixRoomKeyBackup: mocks.resetBackup,
  restoreMatrixRoomKeyBackup: mocks.restoreBackup,
  runMatrixSelfVerification: mocks.selfVerify,
  startMatrixVerification: vi.fn(),
  verifyMatrixRecoveryKey: mocks.verifyKey,
}));

vi.mock("./matrix/actions/devices.js", () => ({
  listMatrixOwnDevices: mocks.devices,
  pruneMatrixStaleGatewayDevices: vi.fn(),
}));

vi.mock("./matrix/client/logging.js", () => ({ setMatrixSdkLogMode: vi.fn() }));

vi.mock("./matrix/sdk/logger.js", () => ({ setMatrixConsoleLogging: vi.fn() }));

vi.mock("./matrix/actions/profile.js", () => ({ updateMatrixOwnProfile: mocks.profile }));

vi.mock("./matrix/accounts.js", () => ({
  resolveMatrixAccountAsync: mocks.account,
  resolveMatrixAccountConfig: mocks.accountConfig,
}));

vi.mock("./matrix/client.js", () => ({ resolveMatrixAuthContext: mocks.authContext }));

vi.mock("./setup-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-core.js")>();
  return {
    ...actual,
    matrixSetupAdapter: {
      ...actual.matrixSetupAdapter,
      applyAccountConfig: mocks.applyAccountConfig,
      validateInput: mocks.validateInput,
    },
  };
});

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      current: mocks.loadConfig,
      mutateConfigFile: mocks.mutateConfig,
      replaceConfigFile: mocks.replaceConfig,
    },
  }),
}));

async function runMatrixCli(command: string | readonly string[], ...args: string[]): Promise<void> {
  const program = new Command();
  registerMatrixCli({ program });
  const argv = typeof command === "string" ? [...command.split(" "), ...args] : command;
  await program.parseAsync(["matrix", ...argv], { from: "user" });
}

const accountPasswordArgs =
  "account add --account ops --homeserver https://matrix.example.org --user-id @ops:example.org --password secret".split(
    " ",
  );

function encryptedSetupArgs(command: string, ...extra: string[]) {
  return command === "account add"
    ? [...accountPasswordArgs, "--enable-e2ee", ...extra]
    : ["encryption", "setup", "--account", "ops", ...extra];
}

function readAccountConfig({ cfg, accountId }: { cfg: CoreConfig; accountId: string }) {
  return cfg.channels?.matrix?.accounts?.[accountId] ?? {};
}

function matrixDevice(deviceId: string, current: boolean) {
  return { deviceId, current, displayName: "OpenClaw Gateway", lastSeenIp: null, lastSeenTs: null };
}

function healthyMatrixBackup(overrides: Record<string, unknown> = {}) {
  return {
    serverVersion: "1",
    activeVersion: "1",
    trusted: true,
    matchesDecryptionKey: true,
    decryptionKeyCached: true,
    ...overrides,
  };
}

function matrixVerificationStatus(overrides: Record<string, unknown> = {}) {
  const { backup: backupOverrides, ...statusOverrides } = overrides;
  return {
    encryptionEnabled: true,
    verified: true,
    localVerified: true,
    crossSigningVerified: true,
    signedByOwner: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE123",
    backup: healthyMatrixBackup(backupOverrides as Record<string, unknown> | undefined),
    recoveryKeyStored: true,
    pendingVerifications: 0,
    ...statusOverrides,
  };
}

function successfulMatrixBootstrap(
  recoveryKeyCreatedAt: string | null = null,
  backupVersion: string | null = null,
) {
  return {
    success: true,
    verification: { recoveryKeyCreatedAt, backupVersion },
  };
}

function mockMatrixVerificationSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "self-1",
    transactionId: "txn-1",
    otherUserId: "@bot:example.org",
    isSelfVerification: true,
    initiatedByMe: true,
    phaseName: "started",
    pending: true,
    methods: ["m.sas.v1"],
    chosenMethod: "m.sas.v1",
    hasSas: true,
    sas: { decimal: [1234, 5678, 9012] },
    ...overrides,
  };
}

describe("matrix CLI verification commands", () => {
  let previousExitCode: typeof process.exitCode;
  let mutationConfig: CoreConfig | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mutationConfig = undefined;
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, "log").mockImplementation(mocks.log);
    vi.spyOn(console, "error").mockImplementation(mocks.error);
    vi.spyOn(process.stdout, "write").mockImplementation(mocks.stdout.mockReturnValue(true));
    mocks.validateInput.mockReturnValue(null);
    mocks.applyAccountConfig.mockImplementation(({ cfg }: { cfg: unknown }) => cfg);
    mocks.loadConfig.mockReturnValue({});
    mocks.replaceConfig.mockResolvedValue(undefined);
    mocks.mutateConfig.mockImplementation(async ({ mutate, afterWrite }) => {
      const snapshot = structuredClone(mutationConfig ?? mocks.loadConfig());
      const draft = structuredClone(snapshot);
      await mutate(draft, { snapshot: { runtimeConfig: snapshot } });
      await mocks.replaceConfig({ nextConfig: draft, afterWrite });
    });
    mocks.authContext.mockImplementation(({ accountId }: { accountId?: string | null }) => ({
      accountId: accountId ?? "default",
    }));
    mocks.account.mockReturnValue({ configured: false });
    mocks.accountConfig.mockReturnValue({ encryption: false });
    mocks.bootstrap.mockResolvedValue(successfulMatrixBootstrap());
    mocks.profile.mockResolvedValue({ displayNameUpdated: true });
    mocks.devices.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode ?? 0;
  });

  it("prints recovery-key and identity-trust diagnostics for device verification failures", async () => {
    mocks.verifyKey.mockResolvedValue({
      ...matrixVerificationStatus({ verified: false }),
      success: false,
      error:
        "Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
      recoveryKeyAccepted: true,
      backupUsable: true,
      deviceOwnerVerified: false,
    });
    await runMatrixCli("verify device", "valid-key");

    expectFailure(
      "Verification failed: Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
    );
    expectLogs(
      "Recovery key accepted: yes",
      "Backup usable: yes",
      "Device verified by owner: no",
      "Backup: active and trusted on this device",
      "- Recovery key can unlock the room-key backup, but full Matrix identity trust is still incomplete. Run openclaw matrix verify self, accept the request in another verified Matrix client, and confirm the SAS only if it matches.",
      "- If you intend to replace the current cross-signing identity, run the shown printf pipeline with the Matrix recovery key env var for this account: printf '%s\\n' \"$MATRIX_RECOVERY_KEY\" | openclaw matrix verify bootstrap --recovery-key-stdin --force-reset-cross-signing.",
    );
  });

  it.each([
    ["5000ms", "an integer"],
    ["-1", "a positive integer"],
  ])("rejects invalid self-verification timeout %s", async (timeout, requirement) => {
    await runMatrixCli("verify self --timeout-ms", timeout);
    expectFailure(`Self-verification failed: --timeout-ms must be ${requirement}`);
    expect(mocks.selfVerify).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "DM lookup details",
      summary: {
        id: "dm-verify-1",
        transactionId: "txn-dm",
        roomId: "!room-'$(x):example.org",
        otherUserId: "@alice:example.org",
        isSelfVerification: false,
      },
      args: ["--user-id", "@alice:example.org", "--room-id", "!room-'$(x):example.org"],
      target: "--user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm",
    },
    {
      name: "option termination before remote ids",
      summary: { id: "local-id", transactionId: "--account=evil'$(touch /tmp/pwn)" },
      args: ["--own-user", "--account", "ops"],
      target: "--account ops -- '--account=evil'\\''$(touch /tmp/pwn)'",
    },
  ])("preserves $name in verification follow-up commands", async ({ summary, args, target }) => {
    mocks.request.mockResolvedValue(
      mockMatrixVerificationSummary({ ...summary, hasSas: !summary.roomId }),
    );
    await runMatrixCli("verify request", ...args);
    if (summary.roomId) {
      expectCall(mocks.request, { userId: summary.otherUserId, roomId: summary.roomId });
      expectLogs(`Room id: ${summary.roomId}`);
    } else {
      expectLogs("SAS decimals: 1234 5678 9012");
    }
    expectLogs(
      `- Then run openclaw matrix verify start ${target} to start SAS verification.`,
      `- Run openclaw matrix verify sas ${target} to display the SAS emoji or decimals.`,
      `- When the SAS matches, run openclaw matrix verify confirm-sas ${target}.`,
    );
  });

  it("sanitizes remote Matrix verification metadata before printing it", async () => {
    mocks.verifications.mockResolvedValue([
      mockMatrixVerificationSummary({
        id: "self-\u001B[31m1",
        initiatedByMe: false,
        transactionId: "txn-\n\u009B31m1",
        otherUserId: "@bot\u001B[2J\u009Dspoof\u0007:example.org",
        otherDeviceId: "PHONE\r\u009B2J123",
        phaseName: "started\u001B[0m",
        methods: ["m.sas.v1\n\u009B31mspoof"],
        chosenMethod: "m.sas.v1\u001B[1m",
        sas: {
          emoji: [
            ["🐶", "Dog\u001B[31m\u009B2J"],
            ["🐱", "Cat\n\u009B31mspoof"],
          ],
        },
        error: "Remote\u001B[31m cancelled\n\u009B31mforged",
      }),
    ]);
    await runMatrixCli("verify list");

    expectLogs(
      "Verification id: self-1",
      "Initiated by OpenClaw: no",
      "Transaction id: txn-1",
      "Other user: @bot:example.org",
      "Other device: PHONE123",
      "Phase: started",
      "Methods: m.sas.v1spoof",
      "Chosen method: m.sas.v1",
      "SAS emoji: 🐶 Dog | 🐱 Catspoof",
      "Verification error: Remote cancelledforged",
    );
  });

  it("sanitizes remote Matrix status metadata before printing diagnostics", async () => {
    const status = setStatus({
      verified: false,
      serverDeviceKnown: true,
      localVerified: false,
      crossSigningVerified: false,
      signedByOwner: false,
      userId: "@bot\u001B[2J:example.org",
      deviceId: "PHONE\r\u009B2J123",
      backup: healthyMatrixBackup({
        serverVersion: "2\u001B[31m",
        activeVersion: "1\u009B2J",
        trusted: false,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
        keyLoadAttempted: true,
        keyLoadError: "Remote\n\u009B31mforged",
      }),
      recoveryKeyStored: false,
      recoveryKey: "test-recovery-key",
    });
    await runMatrixCli(
      "verify status --verbose --allow-degraded-local-state --include-recovery-key",
    );

    expectLogs(
      "User: @bot:example.org",
      "Device: PHONE123",
      "Backup server version: 2",
      "Backup active on this device: 1",
      "Backup key load error: Remoteforged",
    );
    expectCall(mocks.verificationStatus, {
      readiness: "none",
      includeRecoveryKey: true,
    });
    expect(mocks.log.mock.calls.flat().join("\n")).not.toContain("test-recovery-key");
    expectLogs(
      "Recovery key: available (re-run with --json to include the raw key value in output)",
    );
    mocks.backupStatus.mockResolvedValue({ ...status.backup, activeVersion: null });
    await runMatrixCli("verify backup status --verbose");
    expectLogs("Backup trusted by this device: no", "Backup active on this device: no");
  });

  it("rejects oversized recovery key stdin before backup restore", async () => {
    mockRecoveryKeyStdin("x".repeat(1024 * 1024), "x");
    await runMatrixCli("verify backup restore", "--recovery-key-stdin");

    expectFailure("Backup restore failed: Matrix recovery key stdin exceeds 1048576 bytes.");
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves JSON recovery key opt-in=%s", async (include) => {
    const status = matrixVerificationStatus(include ? { recoveryKey: "test-recovery-key" } : {});
    mocks.verificationStatus.mockResolvedValue(status);
    await runMatrixCli("verify status", "--json", ...(include ? ["--include-recovery-key"] : []));

    expectCall(mocks.verificationStatus, { includeRecoveryKey: include });
    expect(jsonOutput()).toEqual(status);
    expect(mocks.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("lists matrix devices", async () => {
    mocks.devices.mockResolvedValue([
      {
        deviceId: "A7hWr\u001B[31mQ70ea",
        displayName: "OpenClaw\u001B[2J Gateway",
        lastSeenIp: "127.0.0.1\u009B2J",
        lastSeenTs: 1_741_507_200_000,
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "OpenClaw Gateway",
        lastSeenIp: null,
        lastSeenTs: 8_700_000_000_000_000,
        current: false,
      },
    ]);
    await runMatrixCli("devices list", "--account", "poe");

    expect(mocks.devices).toHaveBeenCalledWith({ accountId: "poe", cfg: {} });
    expectLogs(
      "Account: poe",
      "- A7hWrQ70ea (current, OpenClaw Gateway)",
      "  Last IP: 127.0.0.1",
      "- BritdXC6iL (OpenClaw Gateway)",
    );
    expect(
      mocks.log.mock.calls.filter(([message]) => String(message).startsWith("  Last seen:")),
    ).toHaveLength(1);
  });

  it("rejects negative Matrix initial sync limits at the CLI boundary", async () => {
    await runMatrixCli([...accountPasswordArgs, "--initial-sync-limit", "-1"]);

    expectFailure("Account setup failed: --initial-sync-limit must be a non-negative integer");
    expect(mocks.validateInput).not.toHaveBeenCalled();
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("skips encryption bootstrap when an encrypted account is already healthy", async () => {
    configureAccount(true);
    setStatus({ serverDeviceKnown: true });
    await runMatrixCli("encryption setup", "--account", "ops", "--json");

    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(jsonOutput()).toMatchObject({
      encryptionChanged: false,
      bootstrap: { cryptoBootstrap: null },
    });
  });

  it.each(["encryption setup", "account add"])(
    "keeps %s private until its crypto clients have retired",
    async (command) => {
      const cfg = configureAccount();
      const bootstrap = holdResult(
        mocks.bootstrap,
        successfulMatrixBootstrap("2026-03-09T06:00:00.000Z", "7"),
      );
      const profile =
        command === "account add"
          ? holdResult(mocks.profile, {
              displayNameUpdated: false,
              avatarUpdated: true,
              resolvedAvatarUrl: "mxc://example.org/avatar",
              convertedAvatarFromHttp: true,
            })
          : undefined;
      const finalRead = command === "encryption setup" ? mocks.verificationStatus : mocks.devices;
      const read = holdResult(
        finalRead,
        command === "encryption setup"
          ? matrixVerificationStatus({
              backup: healthyMatrixBackup({
                decryptionKeyCached: false,
                keyLoadAttempted: true,
              }),
            })
          : [matrixDevice("stale", false), matrixDevice("current", true)],
      );
      const stages = [bootstrap, ...(profile ? [profile] : []), read];
      const latestCfg: CoreConfig = structuredClone(cfg);
      latestCfg.messages = { ackReaction: "updated-during-bootstrap" };
      mutationConfig = latestCfg;
      mockRecoveryKeyStdin("stdin-recovery-key\n");
      const running = runMatrixCli(
        encryptedSetupArgs(
          command,
          ...(command === "encryption setup"
            ? ["--recovery-key-stdin"]
            : ["--avatar-url", "https://example.org/avatar.png", "--name", "Ops Bot"]),
        ),
      );
      try {
        for (const stage of stages) {
          await stage.entered;
          expect(mocks.replaceConfig).not.toHaveBeenCalled();
          stage.release();
        }
      } finally {
        for (const stage of stages) {
          stage.release();
        }
        await running;
      }
      expect(mocks.replaceConfig).toHaveBeenCalledOnce();
      expectCall(mocks.replaceConfig, {
        nextConfig: {
          channels: { matrix: { accounts: { ops: { encryption: true } } } },
          messages: { ackReaction: "updated-during-bootstrap" },
        },
      });
      if (command === "account add") {
        expectCall(mocks.profile, {
          displayName: "Ops Bot",
          avatarUrl: "https://example.org/avatar.png",
        });
        expect(
          mockCallArg(mocks.replaceConfig).nextConfig.channels.matrix.accounts.ops.avatarUrl,
        ).toBe("mxc://example.org/avatar");
      } else {
        expectCall(mocks.bootstrap, {
          recoveryKey: "stdin-recovery-key",
          forceResetCrossSigning: false,
        });
        expect(mocks.log.mock.calls.flat().join("\n")).toContain(
          "Backup key is not loaded on this device",
        );
      }
      expect(process.exitCode).toBe(0);
    },
  );

  it("still saves encryption setup after a failed bootstrap result", async () => {
    mocks.loadConfig.mockReturnValue({ channels: { matrix: {} } });
    mocks.account.mockReturnValue({ configured: true });
    setStatus();
    mocks.bootstrap.mockResolvedValue({
      ...successfulMatrixBootstrap(),
      success: false,
      error: "bootstrap unavailable",
    });
    await runMatrixCli("encryption setup", "--json");
    expect(mocks.replaceConfig).toHaveBeenCalledOnce();
    expectCall(mocks.replaceConfig, { nextConfig: { channels: { matrix: { encryption: true } } } });
    expect(process.exitCode).toBe(1);
    expect(jsonOutput()).toMatchObject({ success: false });
  });

  it.each([
    ["encryption setup", "account replacement"],
    ["account add", "channel disable"],
  ])("does not publish %s after concurrent %s", async (command, change) => {
    const cfg = configureAccount();
    setStatus();
    const replaced = structuredClone(cfg);
    if (change === "channel disable") {
      replaced.channels.matrix.enabled = false;
    } else {
      replaced.channels.matrix.accounts.ops.homeserver = "https://replacement.example.org";
      replaced.channels.matrix.accounts.ops.accessToken = "replacement-token";
    }
    mutationConfig = replaced;
    await runMatrixCli(encryptedSetupArgs(command, "--json"));

    expect(mocks.replaceConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(jsonOutput().error).toContain("changed during setup");
    expect(jsonOutput().error).toContain("run the setup command again");
  });

  it("saves an encrypted account and reports bootstrap, profile, and device-health failures", async () => {
    mocks.accountConfig.mockImplementation(readAccountConfig);
    mocks.bootstrap.mockRejectedValueOnce(new Error("bootstrap failed"));
    mocks.profile.mockRejectedValueOnce(new Error("profile failed"));
    mocks.devices.mockRejectedValueOnce(new Error("device health failed"));
    await runMatrixCli([...accountPasswordArgs, "--enable-e2ee", "--name", "Ops", "--json"]);

    expect(mocks.replaceConfig).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    expect(jsonOutput()).toMatchObject({
      encryptionEnabled: true,
      verificationBootstrap: { attempted: true, success: false, error: "bootstrap failed" },
      profile: { attempted: true, error: "profile failed" },
      deviceHealth: { error: "device health failed" },
    });
  });

  it("sets profile name and avatar", async () => {
    await runMatrixCli(
      "profile set --account alerts --avatar-url mxc://example/avatar --name",
      "Ops Bot",
    );
    expectCall(mocks.profile, {
      accountId: "alerts",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
    });
    expect(mocks.replaceConfig).toHaveBeenCalled();
    expectLogs("Config path: channels.matrix.accounts.alerts");
    expect(process.exitCode).toBe(0);
  });

  it("returns JSON errors for invalid account setup input", async () => {
    mocks.validateInput.mockReturnValue("Matrix requires --homeserver");
    await runMatrixCli("account add", "--json");

    expect(process.exitCode).toBe(1);
    expect(jsonOutput(0)).toEqual({
      error: "Matrix requires --homeserver",
    });
  });

  it("fails status with re-login guidance when the current Matrix device is missing on the server", async () => {
    mocks.authContext.mockReturnValue({ accountId: "assistant" });
    setStatus({
      verified: false,
      serverDeviceKnown: false,
      backup: { serverVersion: null, activeVersion: null },
    });
    await runMatrixCli("verify status");
    expect(process.exitCode).toBe(1);
    expectLogs(
      "Device issue: current Matrix device is missing from the homeserver device list",
      "- This Matrix device is no longer listed on the homeserver. Create a new OpenClaw Matrix device with openclaw matrix account add --homeserver '<url>' --user-id '<@user:server>' --password '<password>' --device-name OpenClaw-Gateway --account assistant. If you use token auth, create a fresh Matrix access token in your Matrix client or admin UI, then run openclaw matrix account add --homeserver '<url>' --access-token '<token>' --account assistant.",
      "Account: assistant",
      "- Run openclaw matrix verify bootstrap --account assistant to create a room key backup.",
    );
    expect(mocks.log.mock.calls.flat().join("\n")).toContain("$MATRIX_RECOVERY_KEY_ASSISTANT");
  });

  it("includes backup reset guidance when the backup key does not match this device", async () => {
    setStatus({
      backup: { matchesDecryptionKey: false },
    });
    await runMatrixCli("verify status");
    expectLogs(
      "- If you want a fresh backup baseline and accept losing unrecoverable history, run openclaw matrix verify backup reset --yes. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.",
    );
  });

  it("requires --yes before resetting the Matrix room-key backup", async () => {
    await runMatrixCli("verify backup reset");

    expect(mocks.resetBackup).not.toHaveBeenCalled();
    expectFailure(
      "Backup reset failed: Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run openclaw matrix verify backup reset --yes.",
    );
  });
});
