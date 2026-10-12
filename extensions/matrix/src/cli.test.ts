import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { formatZonedTimestamp } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCli } from "./cli.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  accept: vi.fn(),
  cancel: vi.fn(),
  confirmSas: vi.fn(),
  backupStatus: vi.fn(),
  sas: vi.fn(),
  verificationStatus: vi.fn(),
  devices: vi.fn(),
  verifications: vi.fn(),
  mismatchSas: vi.fn(),
  pruneDevices: vi.fn(),
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
  logMode: vi.fn(),
  start: vi.fn(),
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

function configureAccount(encryption = false) {
  const account = { encryption, homeserver: "https://matrix.example.org", accessToken: "token" };
  const cfg = {
    channels: { matrix: { enabled: true, accounts: { ops: account } } },
  };
  mocks.loadConfig.mockReturnValue(cfg);
  mocks.account.mockReturnValue({ configured: true, enabled: true, config: account });
  mocks.accountConfig.mockImplementation(
    ({ cfg: current, accountId }: { cfg: CoreConfig; accountId: string }) =>
      current.channels?.matrix?.accounts?.[accountId] ?? {},
  );
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

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const resolvedIndex = callIndex < 0 ? mock.mock.calls.length + callIndex : callIndex;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function stdoutWriteArg(callIndex = -1) {
  return mockCallArg(mocks.stdout, callIndex);
}

vi.mock("./matrix/actions/verification.js", () => ({
  acceptMatrixVerification: mocks.accept,
  bootstrapMatrixVerification: mocks.bootstrap,
  cancelMatrixVerification: mocks.cancel,
  confirmMatrixVerificationSas: mocks.confirmSas,
  getMatrixRoomKeyBackupStatus: mocks.backupStatus,
  getMatrixVerificationSas: mocks.sas,
  getMatrixVerificationStatus: mocks.verificationStatus,
  listMatrixVerifications: mocks.verifications,
  mismatchMatrixVerificationSas: mocks.mismatchSas,
  requestMatrixVerification: mocks.request,
  resetMatrixRoomKeyBackup: mocks.resetBackup,
  restoreMatrixRoomKeyBackup: mocks.restoreBackup,
  runMatrixSelfVerification: mocks.selfVerify,
  startMatrixVerification: mocks.start,
  verifyMatrixRecoveryKey: mocks.verifyKey,
}));

vi.mock("./matrix/actions/devices.js", () => ({
  listMatrixOwnDevices: mocks.devices,
  pruneMatrixStaleGatewayDevices: mocks.pruneDevices,
}));

vi.mock("./matrix/client/logging.js", () => ({
  setMatrixSdkLogMode: mocks.logMode,
}));

vi.mock("./matrix/sdk/logger.js", () => ({ setMatrixConsoleLogging: vi.fn() }));

vi.mock("./matrix/actions/profile.js", () => ({
  updateMatrixOwnProfile: mocks.profile,
}));

vi.mock("./matrix/accounts.js", () => ({
  resolveMatrixAccountAsync: mocks.account,
  resolveMatrixAccountConfig: mocks.accountConfig,
}));

vi.mock("./matrix/client.js", () => ({
  resolveMatrixAuthContext: mocks.authContext,
}));

vi.mock("./setup-core.js", () => ({
  matrixSetupAdapter: {
    applyAccountConfig: mocks.applyAccountConfig,
    validateInput: mocks.validateInput,
  },
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      current: mocks.loadConfig,
      mutateConfigFile: mocks.mutateConfig,
      replaceConfigFile: mocks.replaceConfig,
    },
  }),
}));

async function runMatrixCli(argv: readonly string[]): Promise<void> {
  const program = new Command();
  registerMatrixCli({ program });
  await program.parseAsync(["matrix", ...argv], { from: "user" });
}

function matrixAccountPasswordArgs(accountId = "ops", ...extra: string[]): string[] {
  return [
    "account",
    "add",
    "--account",
    accountId,
    "--homeserver",
    "https://matrix.example.org",
    "--user-id",
    "@ops:example.org",
    "--password",
    "secret",
    ...extra,
  ];
}

function mockMatrixAccountConfigApply(): void {
  mocks.applyAccountConfig.mockImplementation(
    ({ cfg, accountId }: { cfg: Record<string, unknown>; accountId: string }) => ({
      ...cfg,
      channels: {
        ...(cfg.channels as Record<string, unknown> | undefined),
        matrix: { accounts: { [accountId]: { homeserver: "https://matrix.example.org" } } },
      },
    }),
  );
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

function diagnosticMatrixBackup(overrides: Record<string, unknown> = {}) {
  return {
    ...healthyMatrixBackup(),
    keyLoadAttempted: false,
    keyLoadError: null,
    ...overrides,
  };
}

function matrixVerificationState(overrides: Record<string, unknown> = {}) {
  const { backup: backupOverrides, ...statusOverrides } = overrides;
  return {
    encryptionEnabled: true,
    verified: true,
    localVerified: true,
    crossSigningVerified: true,
    signedByOwner: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE123",
    backupVersion: "1",
    backup: healthyMatrixBackup(backupOverrides as Record<string, unknown> | undefined),
    recoveryKeyStored: true,
    recoveryKeyCreatedAt: null,
    ...statusOverrides,
  };
}

function matrixVerificationStatus(overrides: Record<string, unknown> = {}) {
  return { ...matrixVerificationState(overrides), pendingVerifications: 0 };
}

function successfulMatrixBootstrap(
  recoveryKeyCreatedAt: string | null = null,
  backupVersion: string | null = null,
) {
  return {
    success: true,
    verification: { recoveryKeyCreatedAt, backupVersion },
    crossSigning: {},
    pendingVerifications: 0,
    cryptoBootstrap: {},
  };
}

function formatExpectedLocalTimestamp(value: string): string {
  return formatZonedTimestamp(new Date(value), { displaySeconds: true }) ?? value;
}

function mockMatrixVerificationSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "self-1",
    transactionId: "txn-1",
    otherUserId: "@bot:example.org",
    otherDeviceId: "PHONE123",
    isSelfVerification: true,
    initiatedByMe: true,
    phaseName: "started",
    pending: true,
    methods: ["m.sas.v1"],
    chosenMethod: "m.sas.v1",
    hasSas: true,
    sas: {
      decimal: [1234, 5678, 9012],
    },
    completed: false,
    ...overrides,
  };
}

describe("matrix CLI verification commands", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, "log").mockImplementation(mocks.log);
    vi.spyOn(console, "error").mockImplementation(mocks.error);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      mocks.stdout(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    mocks.log.mockReset();
    mocks.error.mockReset();
    mocks.stdout.mockReset();
    mocks.validateInput.mockReturnValue(null);
    mocks.applyAccountConfig.mockImplementation(({ cfg }: { cfg: unknown }) => cfg);
    mocks.loadConfig.mockReturnValue({});
    mocks.replaceConfig.mockResolvedValue(undefined);
    mocks.mutateConfig.mockImplementation(async ({ mutate, afterWrite }) => {
      const draft = structuredClone(mocks.loadConfig());
      await mutate(draft, { snapshot: { runtimeConfig: structuredClone(draft) } });
      await mocks.replaceConfig({ nextConfig: draft, afterWrite });
    });
    mocks.authContext.mockImplementation(
      ({ cfg, accountId }: { cfg: unknown; accountId?: string | null }) => ({
        cfg,
        env: process.env,
        accountId: accountId ?? "default",
        resolved: {},
      }),
    );
    mocks.account.mockReturnValue({
      configured: false,
    });
    mocks.accountConfig.mockReturnValue({
      encryption: false,
    });
    mocks.bootstrap.mockResolvedValue(successfulMatrixBootstrap());
    mocks.resetBackup.mockResolvedValue({
      success: true,
      previousVersion: "1",
      deletedVersion: "1",
      createdVersion: "2",
      backup: diagnosticMatrixBackup({ serverVersion: "2", activeVersion: "2" }),
    });
    mocks.profile.mockResolvedValue({
      skipped: false,
      displayNameUpdated: true,
      avatarUpdated: false,
      resolvedAvatarUrl: null,
      convertedAvatarFromHttp: false,
    });
    mocks.devices.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode ?? 0;
  });

  it("prints recovery-key and identity-trust diagnostics for device verification failures", async () => {
    mocks.verifyKey.mockResolvedValue({
      ...matrixVerificationState({
        verified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        backupVersion: "7",
        backup: diagnosticMatrixBackup({
          serverVersion: "7",
          activeVersion: "7",
          keyLoadAttempted: true,
        }),
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      }),
      success: false,
      error:
        "Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
      recoveryKeyAccepted: true,
      backupUsable: true,
      deviceOwnerVerified: false,
    });
    await runMatrixCli(["verify", "device", "valid-key"]);

    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith(
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

  it("runs interactive Matrix self-verification in one CLI flow", async () => {
    mocks.selfVerify.mockResolvedValue(
      mockMatrixVerificationSummary({
        completed: true,
        deviceOwnerVerified: true,
        ownerVerification: matrixVerificationState({ recoveryKeyId: null }),
        pending: false,
        phaseName: "done",
      }),
    );
    await runMatrixCli(["verify", "self", "--account", "ops", "--timeout-ms", "5000"]);

    const selfVerifyArg = mockCallArg(mocks.selfVerify) as Record<string, unknown>;
    expectRecordFields(selfVerifyArg, {
      accountId: "ops",
      cfg: {},
      timeoutMs: 5000,
    });
    expect(selfVerifyArg.onRequested).toBeTypeOf("function");
    expect(selfVerifyArg.onReady).toBeTypeOf("function");
    expect(selfVerifyArg.onSas).toBeTypeOf("function");
    expect(selfVerifyArg.confirmSas).toBeTypeOf("function");
    expectLogs(
      "Self-verification complete.",
      "Device verified by owner: yes",
      "Cross-signing verified: yes",
      "Signed by owner: yes",
      "Backup: active and trusted on this device",
    );
  });

  it("rejects malformed Matrix self-verification timeout values", async () => {
    await runMatrixCli(["verify", "self", "--timeout-ms", "5000ms"]);

    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith(
      "Self-verification failed: --timeout-ms must be an integer",
    );
    expect(mocks.selfVerify).not.toHaveBeenCalled();
  });

  it("rejects non-positive Matrix self-verification timeout values", async () => {
    await runMatrixCli(["verify", "self", "--timeout-ms", "-1"]);

    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith(
      "Self-verification failed: --timeout-ms must be a positive integer",
    );
    expect(mocks.selfVerify).not.toHaveBeenCalled();
  });

  it("prints DM lookup details in Matrix verification follow-up commands", async () => {
    mocks.request.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "dm-verify-1",
        transactionId: "txn-dm",
        roomId: "!room-'$(x):example.org",
        otherUserId: "@alice:example.org",
        isSelfVerification: false,
        hasSas: false,
        sas: undefined,
      }),
    );
    await runMatrixCli([
      "verify",
      "request",
      "--user-id",
      "@alice:example.org",
      "--room-id",
      "!room-'$(x):example.org",
    ]);

    expect(mocks.request).toHaveBeenCalledWith({
      accountId: "default",
      cfg: {},
      ownUser: undefined,
      userId: "@alice:example.org",
      deviceId: undefined,
      roomId: "!room-'$(x):example.org",
    });
    expectLogs(
      "Room id: !room-'$(x):example.org",
      "- Then run openclaw matrix verify start --user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm to start SAS verification.",
      "- Run openclaw matrix verify sas --user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm to display the SAS emoji or decimals.",
      "- When the SAS matches, run openclaw matrix verify confirm-sas --user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm.",
    );
  });

  it("terminates options before remote Matrix verification ids in follow-up commands", async () => {
    mocks.request.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "local-id",
        transactionId: "--account=evil'$(touch /tmp/pwn)",
        hasSas: false,
        sas: undefined,
      }),
    );
    await runMatrixCli(["verify", "request", "--own-user", "--account", "ops"]);

    expectLogs(
      "- Then run openclaw matrix verify start --account ops -- '--account=evil'\\''$(touch /tmp/pwn)' to start SAS verification.",
      "- Run openclaw matrix verify sas --account ops -- '--account=evil'\\''$(touch /tmp/pwn)' to display the SAS emoji or decimals.",
      "- When the SAS matches, run openclaw matrix verify confirm-sas --account ops -- '--account=evil'\\''$(touch /tmp/pwn)'.",
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
    await runMatrixCli(["verify", "list"]);

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
    mocks.verificationStatus.mockResolvedValue(
      matrixVerificationStatus({
        verified: false,
        serverDeviceKnown: true,
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        userId: "@bot\u001B[2J:example.org",
        deviceId: "PHONE\r\u009B2J123",
        backupVersion: "1\u001B[31m",
        backup: diagnosticMatrixBackup({
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
      }),
    );
    await runMatrixCli([
      "verify",
      "status",
      "--verbose",
      "--allow-degraded-local-state",
      "--include-recovery-key",
    ]);

    expectLogs(
      "User: @bot:example.org",
      "Device: PHONE123",
      "Backup server version: 2",
      "Backup active on this device: 1",
      "Backup key load error: Remoteforged",
    );
    expectRecordFields(mockCallArg(mocks.verificationStatus), {
      readiness: "none",
      cfg: {},
      includeRecoveryKey: true,
    });
    expectLogs(
      `Recovery key created at: ${formatExpectedLocalTimestamp("2026-02-25T20:10:11.000Z")}`,
    );
    expect(mocks.log.mock.calls.flat().join("\n")).not.toContain("test-recovery-key");
    expectLogs(
      "Recovery key: available (re-run with --json to include the raw key value in output)",
    );
  });

  it("shows Matrix SAS diagnostics and confirm/mismatch guidance", async () => {
    mocks.sas.mockResolvedValue({
      decimal: [1234, 5678, 9012],
    });
    await runMatrixCli(["verify", "sas", "self-1"]);

    expect(mocks.sas).toHaveBeenCalledWith("self-1", {
      accountId: "default",
      cfg: {},
    });
    expectLogs(
      "SAS decimals: 1234 5678 9012",
      "- If they match, run openclaw matrix verify confirm-sas -- self-1.",
      "- If they do not match, run openclaw matrix verify mismatch-sas -- self-1.",
    );
  });

  it("confirms, rejects, accepts, starts, and cancels Matrix verification requests", async () => {
    mocks.accept.mockResolvedValue(mockMatrixVerificationSummary({ id: "in-1" }));
    mocks.start.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "in-1",
        roomId: "!dm:example.org",
        otherUserId: "@alice:example.org",
      }),
    );
    mocks.confirmSas.mockResolvedValue(
      mockMatrixVerificationSummary({ id: "in-1", completed: true, pending: false }),
    );
    mocks.mismatchSas.mockResolvedValue(
      mockMatrixVerificationSummary({ id: "in-1", phaseName: "cancelled", pending: false }),
    );
    mocks.cancel.mockResolvedValue(
      mockMatrixVerificationSummary({ id: "in-1", phaseName: "cancelled", pending: false }),
    );
    await runMatrixCli(["verify", "accept", "in-1"]);
    expectLogs("- Run openclaw matrix verify start -- txn-1 to start SAS verification.");
    await runMatrixCli([
      "verify",
      "start",
      "in-1",
      "--user-id",
      "@alice:example.org",
      "--room-id",
      "!dm:example.org",
    ]);
    expectLogs(
      "- If they match, run openclaw matrix verify confirm-sas --user-id @alice:example.org --room-id '!dm:example.org' -- txn-1.",
    );
    await runMatrixCli(["verify", "confirm-sas", "in-1"]);
    await runMatrixCli(["verify", "mismatch-sas", "in-1"]);
    await runMatrixCli(["verify", "cancel", "in-1", "--reason", "changed my mind"]);

    expect(mocks.accept).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
    });
    expect(mocks.start).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
      method: "sas",
      verificationDmUserId: "@alice:example.org",
      verificationDmRoomId: "!dm:example.org",
    });
    expect(mocks.confirmSas).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
    });
    expect(mocks.mismatchSas).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
    });
    expect(mocks.cancel).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
      reason: "changed my mind",
      code: undefined,
    });
  });

  it("rejects oversized recovery key stdin before backup restore", async () => {
    mockRecoveryKeyStdin("x".repeat(1024 * 1024), "x");
    await runMatrixCli(["verify", "backup", "restore", "--recovery-key-stdin"]);

    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith(
      "Backup restore failed: Matrix recovery key stdin exceeds 1048576 bytes.",
    );
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves JSON recovery key opt-in=%s", async (include) => {
    const status = matrixVerificationStatus(include ? { recoveryKey: "test-recovery-key" } : {});
    mocks.verificationStatus.mockResolvedValue(status);
    await runMatrixCli([
      "verify",
      "status",
      "--json",
      ...(include ? ["--include-recovery-key"] : []),
    ]);

    expectRecordFields(mockCallArg(mocks.verificationStatus), {
      includeRecoveryKey: include,
    });
    expect(JSON.parse(String(stdoutWriteArg()))).toEqual(status);
    expect(mocks.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("passes loaded cfg to all verify subcommands", async () => {
    const fakeCfg = { channels: { matrix: {} } };
    mocks.loadConfig.mockReturnValue(fakeCfg);

    const created = "2026-02-25T20:10:11.000Z";
    mocks.bootstrap.mockResolvedValue({
      ...successfulMatrixBootstrap(),
      verification: matrixVerificationState({ recoveryKeyCreatedAt: created }),
      crossSigning: {
        published: true,
        masterKeyPublished: true,
        selfSigningKeyPublished: true,
        userSigningKeyPublished: true,
      },
    });
    await runMatrixCli(["verify", "bootstrap", "--verbose"]);
    expectRecordFields(mockCallArg(mocks.bootstrap), { cfg: fakeCfg });

    mocks.verifyKey.mockResolvedValue({
      ...matrixVerificationState(),
      success: true,
      verifiedAt: created,
    });
    await runMatrixCli(["verify", "device", "test-key", "--verbose"]);
    expect(mockCallArg(mocks.verifyKey)).toBe("test-key");
    expectRecordFields(mockCallArg(mocks.verifyKey, 0, 1), { cfg: fakeCfg });

    mocks.backupStatus.mockResolvedValue({});
    await runMatrixCli(["verify", "backup", "status"]);
    expectRecordFields(mockCallArg(mocks.backupStatus), { cfg: fakeCfg });

    await runMatrixCli(["verify", "backup", "reset", "--yes"]);
    expectRecordFields(mockCallArg(mocks.resetBackup), { cfg: fakeCfg });

    mocks.restoreBackup.mockResolvedValue({
      success: true,
      imported: 0,
      total: 0,
      backup: {},
    });
    await runMatrixCli(["verify", "backup", "restore"]);
    expectRecordFields(mockCallArg(mocks.restoreBackup), { cfg: fakeCfg });
    expectLogs(
      `Recovery key created at: ${formatExpectedLocalTimestamp(created)}`,
      `Verified at: ${formatExpectedLocalTimestamp(created)}`,
    );
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
    await runMatrixCli(["devices", "list", "--account", "poe"]);

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

  it("prunes stale matrix gateway devices", async () => {
    const current = matrixDevice("A7hWrQ70ea", true);
    const stale = matrixDevice("BritdXC6iL", false);
    mocks.pruneDevices.mockResolvedValue({
      before: [current, stale],
      staleGatewayDeviceIds: [stale.deviceId],
      currentDeviceId: current.deviceId,
      deletedDeviceIds: [stale.deviceId],
      remainingDevices: [current],
    });
    await runMatrixCli(["devices", "prune-stale", "--account", "poe"]);

    expect(mocks.pruneDevices).toHaveBeenCalledWith({
      accountId: "poe",
      cfg: {},
    });
    expectLogs(
      "Deleted stale OpenClaw devices: BritdXC6iL",
      "Current device: A7hWrQ70ea",
      "Remaining devices: 1",
    );
  });

  it("rejects negative Matrix initial sync limits at the CLI boundary", async () => {
    await runMatrixCli(matrixAccountPasswordArgs("ops", "--initial-sync-limit", "-1"));

    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith(
      "Account setup failed: --initial-sync-limit must be a non-negative integer",
    );
    expect(mocks.validateInput).not.toHaveBeenCalled();
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("skips encryption bootstrap when an encrypted account is already healthy", async () => {
    configureAccount(true);
    mocks.verificationStatus.mockResolvedValue(
      matrixVerificationStatus({ serverDeviceKnown: true }),
    );
    await runMatrixCli(["encryption", "setup", "--account", "ops", "--json"]);

    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.verificationStatus).toHaveBeenCalledTimes(1);
    const statusArg = mockCallArg(mocks.verificationStatus) as Record<string, unknown>;
    expectRecordFields(statusArg, { accountId: "ops", readiness: "none" });
    expect(statusArg.cfg).toBeTypeOf("object");
    const jsonOutput = stdoutWriteArg();
    expect(typeof jsonOutput).toBe("string");
    const payload = JSON.parse(String(jsonOutput)) as Record<string, unknown>;
    expectRecordFields(payload, { accountId: "ops", encryptionChanged: false });
    expectRecordFields(payload.bootstrap, { success: true, cryptoBootstrap: null });
    expectRecordFields(payload.status, { verified: true });
  });

  it.each(["encryption setup", "account add"])(
    "keeps %s private until its crypto clients have retired",
    async (command) => {
      const cfg = configureAccount();
      const bootstrapEntered = createDeferred<void>();
      const bootstrapRetired = createDeferred<void>();
      const profileEntered = createDeferred<void>();
      const profileRetired = createDeferred<void>();
      const readEntered = createDeferred<void>();
      const readRetired = createDeferred<void>();
      mocks.bootstrap.mockImplementationOnce(async () => {
        bootstrapEntered.resolve();
        await bootstrapRetired.promise;
        return successfulMatrixBootstrap("2026-03-09T06:00:00.000Z", "7");
      });
      if (command === "account add") {
        mocks.profile.mockImplementationOnce(async () => {
          profileEntered.resolve();
          await profileRetired.promise;
          return {
            displayNameUpdated: false,
            avatarUpdated: true,
            resolvedAvatarUrl: "mxc://example.org/avatar",
            convertedAvatarFromHttp: true,
          };
        });
      }
      const finalRead = command === "encryption setup" ? mocks.verificationStatus : mocks.devices;
      finalRead.mockImplementationOnce(async () => {
        readEntered.resolve();
        await readRetired.promise;
        return command === "encryption setup"
          ? matrixVerificationStatus({
              backup: diagnosticMatrixBackup({
                activeVersion: null,
                matchesDecryptionKey: false,
                decryptionKeyCached: false,
                keyLoadAttempted: true,
              }),
            })
          : [matrixDevice("stale", false), matrixDevice("current", true)];
      });
      const gatewayActivations: CoreConfig[] = [];
      const latestCfg: CoreConfig = structuredClone(cfg);
      latestCfg.messages = { ackReaction: "updated-during-bootstrap" };
      mocks.mutateConfig.mockImplementationOnce(async ({ mutate, afterWrite }) => {
        const draft = structuredClone(latestCfg);
        await mutate(draft, { snapshot: { runtimeConfig: latestCfg } });
        await mocks.replaceConfig({ nextConfig: draft, afterWrite });
      });
      mocks.replaceConfig.mockImplementationOnce(
        async ({ nextConfig }: { nextConfig: CoreConfig }) => {
          gatewayActivations.push(nextConfig);
        },
      );
      mockRecoveryKeyStdin("stdin-recovery-key\n");
      const running = runMatrixCli(
        command === "encryption setup"
          ? ["encryption", "setup", "--account", "ops", "--recovery-key-stdin"]
          : matrixAccountPasswordArgs(
              "ops",
              "--enable-e2ee",
              "--avatar-url",
              "https://example.org/avatar.png",
            ),
      );
      try {
        await bootstrapEntered.promise;
        expect(gatewayActivations).toEqual([]);
        bootstrapRetired.resolve();
        if (command === "account add") {
          await profileEntered.promise;
          expect(gatewayActivations).toEqual([]);
          profileRetired.resolve();
        }
        await readEntered.promise;
        expect(gatewayActivations).toEqual([]);
      } finally {
        bootstrapRetired.resolve();
        profileRetired.resolve();
        readRetired.resolve();
        await running;
      }
      expect(gatewayActivations).toHaveLength(1);
      expect(gatewayActivations[0]?.channels?.matrix?.accounts?.ops?.encryption).toBe(true);
      expect(gatewayActivations[0]?.messages?.ackReaction).toBe("updated-during-bootstrap");
      if (command === "account add") {
        expect(gatewayActivations[0]?.channels?.matrix?.accounts?.ops?.avatarUrl).toBe(
          "mxc://example.org/avatar",
        );
        expectLogs("Matrix verification bootstrap: complete", "Backup version: 7");
        expect(mocks.log.mock.calls.flat().join("\n")).toContain(
          "stale OpenClaw devices detected (stale)",
        );
      } else {
        expectRecordFields(mockCallArg(mocks.bootstrap), {
          recoveryKey: "stdin-recovery-key",
          forceResetCrossSigning: false,
        });
        expectLogs(
          "Bootstrap success: yes",
          "Encryption config: enabled at channels.matrix.accounts.ops",
        );
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
    mocks.verificationStatus.mockResolvedValue(matrixVerificationStatus());
    mocks.bootstrap.mockResolvedValue({
      ...successfulMatrixBootstrap(),
      success: false,
      error: "bootstrap unavailable",
    });
    await runMatrixCli(["encryption", "setup", "--json"]);
    expect(mocks.replaceConfig).toHaveBeenCalledOnce();
    const write = mockCallArg(mocks.replaceConfig) as { nextConfig: CoreConfig };
    expect(write.nextConfig.channels?.matrix?.encryption).toBe(true);
    expect(process.exitCode).toBe(1);
    expectRecordFields(JSON.parse(String(stdoutWriteArg())), { success: false });
  });

  it.each([
    ["encryption setup", "account replacement"],
    ["account add", "channel disable"],
  ])("does not publish %s after concurrent %s", async (command, change) => {
    const cfg = configureAccount();
    mocks.verificationStatus.mockResolvedValue(matrixVerificationStatus());
    const replaced = structuredClone(cfg);
    if (change === "channel disable") {
      replaced.channels.matrix.enabled = false;
    } else {
      replaced.channels.matrix.accounts.ops.homeserver = "https://replacement.example.org";
      replaced.channels.matrix.accounts.ops.accessToken = "replacement-token";
    }
    mocks.mutateConfig.mockImplementationOnce(async ({ mutate, afterWrite }) => {
      const draft = structuredClone(replaced);
      await mutate(draft, { snapshot: { runtimeConfig: replaced } });
      await mocks.replaceConfig({ nextConfig: draft, afterWrite });
    });
    await runMatrixCli(
      command === "encryption setup"
        ? ["encryption", "setup", "--account", "ops", "--json"]
        : matrixAccountPasswordArgs("ops", "--enable-e2ee", "--json"),
    );

    expect(mocks.replaceConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stdoutWriteArg())).error).toContain("changed during setup");
    expect(JSON.parse(String(stdoutWriteArg())).error).toContain("run the setup command again");
  });

  it("saves an encrypted account and reports bootstrap, profile, and device-health failures", async () => {
    mocks.accountConfig.mockImplementation(
      ({ cfg, accountId }: { cfg: CoreConfig; accountId: string }) =>
        cfg.channels?.matrix?.accounts?.[accountId] ?? {},
    );
    mocks.bootstrap.mockRejectedValueOnce(new Error("bootstrap failed"));
    mocks.profile.mockRejectedValueOnce(new Error("profile failed"));
    mocks.devices.mockRejectedValueOnce(new Error("device health failed"));
    await runMatrixCli(
      matrixAccountPasswordArgs("ops", "--enable-e2ee", "--name", "Ops", "--json"),
    );

    expect(mocks.replaceConfig).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    const result = JSON.parse(String(stdoutWriteArg()));
    expect(result.encryptionEnabled).toBe(true);
    expectRecordFields(result.verificationBootstrap, {
      attempted: true,
      success: false,
      error: "bootstrap failed",
    });
    expectRecordFields(result.profile, { attempted: true, error: "profile failed" });
    expectRecordFields(result.deviceHealth, { error: "device health failed" });
  });

  it("forwards --avatar-url through account add setup and profile sync", async () => {
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mockMatrixAccountConfigApply();
    await runMatrixCli([
      "account",
      "add",
      "--name",
      "Ops Bot",
      "--homeserver",
      "https://matrix.example.org",
      "--access-token",
      "ops-token",
      "--avatar-url",
      "mxc://example/ops-avatar",
    ]);

    const applyArg = mockCallArg(mocks.applyAccountConfig) as Record<string, unknown>;
    expect(applyArg.accountId).toBe("ops-bot");
    expectRecordFields(applyArg.input, {
      name: "Ops Bot",
      homeserver: "https://matrix.example.org",
      accessToken: "ops-token",
      avatarUrl: "mxc://example/ops-avatar",
    });
    const profileArg = mockCallArg(mocks.profile) as {
      cfg?: CoreConfig;
      accountId?: string;
      displayName?: string;
      avatarUrl?: string;
    };
    expect(profileArg.cfg?.channels?.matrix?.accounts?.["ops-bot"]?.homeserver).toBe(
      "https://matrix.example.org",
    );
    expectRecordFields(profileArg, {
      accountId: "ops-bot",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/ops-avatar",
    });
    expectLogs("Saved matrix account: ops-bot", "Config path: channels.matrix.accounts.ops-bot");
  });

  it("sets profile name and avatar via profile set command", async () => {
    await runMatrixCli([
      "profile",
      "set",
      "--account",
      "alerts",
      "--name",
      "Alerts Bot",
      "--avatar-url",
      "mxc://example/avatar",
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expectRecordFields(mockCallArg(mocks.profile), {
      accountId: "alerts",
      displayName: "Alerts Bot",
      avatarUrl: "mxc://example/avatar",
    });
    expect(mocks.replaceConfig).toHaveBeenCalled();
    expectLogs("Account: alerts", "Config path: channels.matrix.accounts.alerts");
  });

  it("returns JSON errors for invalid account setup input", async () => {
    mocks.validateInput.mockReturnValue("Matrix requires --homeserver");
    await runMatrixCli(["account", "add", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stdoutWriteArg(0)))).toEqual({
      error: "Matrix requires --homeserver",
    });
  });

  for (const scenario of [
    {
      name: "fails status with re-login guidance when the current Matrix device is missing on the server",
      status: {
        verified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        serverDeviceKnown: false,
        backupVersion: null,
        backup: diagnosticMatrixBackup({
          serverVersion: null,
          activeVersion: null,
          trusted: null,
          matchesDecryptionKey: null,
          decryptionKeyCached: true,
        }),
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      },
      expectedExitCode: 1,
      expectedLogs: [
        "Device issue: current Matrix device is missing from the homeserver device list",
        "- This Matrix device is no longer listed on the homeserver. Create a new OpenClaw Matrix device with openclaw matrix account add --homeserver '<url>' --user-id '<@user:server>' --password '<password>' --device-name OpenClaw-Gateway --account assistant. If you use token auth, create a fresh Matrix access token in your Matrix client or admin UI, then run openclaw matrix account add --homeserver '<url>' --access-token '<token>' --account assistant.",
      ],
    },
    {
      name: "includes backup reset guidance when the backup key does not match this device",
      status: {
        backupVersion: "21868",
        backup: diagnosticMatrixBackup({
          serverVersion: "21868",
          activeVersion: "21868",
          matchesDecryptionKey: false,
        }),
        recoveryKeyCreatedAt: "2026-03-09T14:40:00.000Z",
      },
      expectedLogs: [
        "- If you want a fresh backup baseline and accept losing unrecoverable history, run openclaw matrix verify backup reset --yes. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.",
      ],
    },
  ]) {
    it(scenario.name, async () => {
      if ("expectedExitCode" in scenario) {
        mocks.authContext.mockImplementation(({ cfg }: { cfg: CoreConfig }) => ({
          cfg,
          accountId: "assistant",
        }));
      }
      mocks.verificationStatus.mockResolvedValue(matrixVerificationStatus(scenario.status));
      await runMatrixCli(["verify", "status"]);

      if ("expectedExitCode" in scenario) {
        expect(process.exitCode).toBe(scenario.expectedExitCode);
        expectLogs(
          "Account: assistant",
          "- Run openclaw matrix verify bootstrap --account assistant to create a room key backup.",
        );
        expect(mocks.log.mock.calls.flat().join("\n")).toContain("$MATRIX_RECOVERY_KEY_ASSISTANT");
      }
      for (const message of scenario.expectedLogs) {
        expectLogs(message);
      }
    });
  }

  it("requires --yes before resetting the Matrix room-key backup", async () => {
    await runMatrixCli(["verify", "backup", "reset"]);

    expect(process.exitCode).toBe(1);
    expect(mocks.resetBackup).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Backup reset failed: Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run openclaw matrix verify backup reset --yes.",
    );
  });

  it("prints backup health lines for verify backup status in verbose mode", async () => {
    mocks.backupStatus.mockResolvedValue(
      diagnosticMatrixBackup({
        serverVersion: "2",
        activeVersion: null,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
        keyLoadAttempted: true,
      }),
    );
    await runMatrixCli(["verify", "backup", "status", "--verbose"]);

    expectLogs(
      "Backup server version: 2",
      "Backup active on this device: no",
      "Backup trusted by this device: yes",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
