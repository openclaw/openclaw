import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixProfileSyncResult } from "../profile.js";
import type { MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import type { MatrixLegacyCryptoRestoreResult } from "./legacy-crypto-restore.js";
import type { MatrixStartupVerificationOutcome } from "./startup-verification.js";
import { runMatrixStartupMaintenance } from "./startup.js";

function createVerificationStatus(
  overrides: Partial<MatrixOwnDeviceVerificationStatus> = {},
): MatrixOwnDeviceVerificationStatus {
  return {
    encryptionEnabled: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE",
    verified: false,
    localVerified: false,
    crossSigningVerified: false,
    signedByOwner: false,
    recoveryKeyStored: false,
    recoveryKeyCreatedAt: null,
    recoveryKeyId: null,
    backupVersion: null,
    backup: {
      serverVersion: null,
      activeVersion: null,
      trusted: null,
      matchesDecryptionKey: null,
      decryptionKeyCached: null,
      keyLoadAttempted: false,
      keyLoadError: null,
    },
    ...overrides,
  };
}

function createProfileSyncResult(
  overrides: Partial<MatrixProfileSyncResult> = {},
): MatrixProfileSyncResult {
  return {
    skipped: false,
    displayNameUpdated: false,
    avatarUpdated: false,
    resolvedAvatarUrl: null,
    uploadedAvatarSource: null,
    convertedAvatarFromHttp: false,
    ...overrides,
  };
}

function createStartupVerificationOutcome(
  kind: Exclude<MatrixStartupVerificationOutcome["kind"], "unsupported">,
  overrides: Partial<Extract<MatrixStartupVerificationOutcome, { kind: typeof kind }>> = {},
): MatrixStartupVerificationOutcome {
  return {
    kind,
    verification: createVerificationStatus({ verified: kind === "verified" }),
    ...overrides,
  } as MatrixStartupVerificationOutcome;
}

function createLegacyCryptoRestoreResult(
  overrides: Partial<MatrixLegacyCryptoRestoreResult> = {},
): MatrixLegacyCryptoRestoreResult {
  return {
    kind: "skipped",
    ...overrides,
  } as MatrixLegacyCryptoRestoreResult;
}

const hoisted = vi.hoisted(() => ({
  maybeRestoreLegacyMatrixBackup: vi.fn(async () => createLegacyCryptoRestoreResult()),
  summarizeMatrixDeviceHealth: vi.fn(() => ({
    staleOpenClawDevices: [] as Array<{ deviceId: string }>,
  })),
  syncMatrixOwnProfile: vi.fn(async () => createProfileSyncResult()),
  ensureMatrixStartupVerification: vi.fn(async () => createStartupVerificationOutcome("verified")),
  updateMatrixAccountConfig: vi.fn((cfg: unknown) => cfg),
}));

vi.mock("../config-update.js", () => ({
  updateMatrixAccountConfig: hoisted.updateMatrixAccountConfig,
}));

vi.mock("../device-health.js", () => ({
  summarizeMatrixDeviceHealth: hoisted.summarizeMatrixDeviceHealth,
}));

vi.mock("../profile.js", () => ({
  syncMatrixOwnProfile: hoisted.syncMatrixOwnProfile,
}));

vi.mock("./legacy-crypto-restore.js", () => ({
  maybeRestoreLegacyMatrixBackup: hoisted.maybeRestoreLegacyMatrixBackup,
}));

vi.mock("./startup-verification.js", () => ({
  ensureMatrixStartupVerification: hoisted.ensureMatrixStartupVerification,
}));

describe("runMatrixStartupMaintenance", () => {
  beforeEach(() => {
    hoisted.maybeRestoreLegacyMatrixBackup
      .mockClear()
      .mockResolvedValue(createLegacyCryptoRestoreResult());
    hoisted.summarizeMatrixDeviceHealth.mockClear().mockReturnValue({ staleOpenClawDevices: [] });
    hoisted.syncMatrixOwnProfile.mockClear().mockResolvedValue(createProfileSyncResult());
    hoisted.ensureMatrixStartupVerification
      .mockClear()
      .mockResolvedValue(createStartupVerificationOutcome("verified"));
    hoisted.updateMatrixAccountConfig.mockClear().mockImplementation((cfg: unknown) => cfg);
  });

  function createParams(): Parameters<typeof runMatrixStartupMaintenance>[0] {
    return {
      client: {
        crypto: {},
        listOwnDevices: vi.fn(async () => []),
        getOwnDeviceVerificationStatus: vi.fn(async () => createVerificationStatus()),
      } as never,
      auth: {
        accountId: "ops",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
        encryption: false,
      },
      accountId: "ops",
      effectiveAccountId: "ops",
      accountConfig: {
        name: "Ops Bot",
        avatarUrl: "https://example.org/avatar.png",
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      logVerboseMessage: vi.fn(),
      loadConfig: vi.fn(() => ({ channels: { matrix: {} } })),
      writeConfigFile: vi.fn(async () => {}),
      loadWebMedia: vi.fn(async () => ({
        buffer: Buffer.from("avatar"),
        contentType: "image/png",
        fileName: "avatar.png",
      })),
      env: {},
    };
  }

  it("persists converted avatar URLs after profile sync", async () => {
    const params = createParams();
    const updatedCfg = { channels: { matrix: { avatarUrl: "mxc://avatar" } } };
    hoisted.syncMatrixOwnProfile.mockResolvedValue(
      createProfileSyncResult({
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://avatar",
        uploadedAvatarSource: "http",
        convertedAvatarFromHttp: true,
      }),
    );
    hoisted.updateMatrixAccountConfig.mockReturnValue(updatedCfg);

    await runMatrixStartupMaintenance(params);

    expect(hoisted.syncMatrixOwnProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "@bot:example.org",
        displayName: "Ops Bot",
        avatarUrl: "https://example.org/avatar.png",
      }),
    );
    expect(hoisted.updateMatrixAccountConfig).toHaveBeenCalledWith(
      { channels: { matrix: {} } },
      "ops",
      { avatarUrl: "mxc://avatar" },
    );
    expect(params.writeConfigFile).toHaveBeenCalledWith(updatedCfg as never);
    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: persisted converted avatar URL for account ops (mxc://avatar)",
    );
  });

  it("reports stale devices, pending verification, and restored legacy backups", async () => {
    const params = createParams();
    params.auth.encryption = true;
    hoisted.summarizeMatrixDeviceHealth.mockReturnValue({
      staleOpenClawDevices: [{ deviceId: "DEV123" }],
    });
    hoisted.ensureMatrixStartupVerification.mockResolvedValue(
      createStartupVerificationOutcome("pending"),
    );
    hoisted.maybeRestoreLegacyMatrixBackup.mockResolvedValue(
      createLegacyCryptoRestoreResult({
        kind: "restored",
        imported: 2,
        total: 3,
        localOnlyKeys: 1,
      }),
    );

    await runMatrixStartupMaintenance(params);

    expect(params.logger.warn).toHaveBeenCalledWith(
      "matrix: stale OpenClaw devices detected for @bot:example.org: DEV123. Run 'openclaw matrix devices prune-stale --account ops' to keep encrypted-room trust healthy.",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      "matrix: device not verified — run 'openclaw matrix verify device <key>' to enable E2EE",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      "matrix: startup verification request is already pending; finish it in another Matrix client",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      "matrix: restored 2/3 room key(s) from legacy encrypted-state backup",
    );
    expect(params.logger.warn).toHaveBeenCalledWith(
      "matrix: 1 legacy local-only room key(s) were never backed up and could not be restored automatically",
    );
  });

  it("logs cooldown and request-failure verification outcomes without throwing", async () => {
    const params = createParams();
    params.auth.encryption = true;
    hoisted.ensureMatrixStartupVerification.mockResolvedValueOnce(
      createStartupVerificationOutcome("cooldown", { retryAfterMs: 321 }),
    );

    await runMatrixStartupMaintenance(params);

    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: skipped startup verification request due to cooldown (retryAfterMs=321)",
    );

    hoisted.ensureMatrixStartupVerification.mockResolvedValueOnce(
      createStartupVerificationOutcome("request-failed", { error: "boom" }),
    );

    await runMatrixStartupMaintenance(params);

    expect(params.logger.debug).toHaveBeenCalledWith(
      "Matrix startup verification request failed (non-fatal)",
      { error: "boom" },
    );
  });
});
