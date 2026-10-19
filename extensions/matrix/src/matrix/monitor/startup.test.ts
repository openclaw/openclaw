import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixProfileSyncResult } from "../profile.js";
import type { MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import { runMatrixStartupMaintenance } from "./startup.js";
const deps = vi.hoisted(() => ({
  summarizeMatrixDeviceHealth:
    vi.fn<typeof import("../device-health.js").summarizeMatrixDeviceHealth>(),
  syncMatrixOwnProfile: vi.fn<typeof import("../profile.js").syncMatrixOwnProfile>(),
  ensureMatrixStartupVerification:
    vi.fn<typeof import("./startup-verification.js").ensureMatrixStartupVerification>(),
  updateMatrixAccountConfig:
    vi.fn<typeof import("../config-update.js").updateMatrixAccountConfig>(),
}));
vi.mock("../device-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../device-health.js")>()),
  summarizeMatrixDeviceHealth: deps.summarizeMatrixDeviceHealth,
}));
vi.mock("../profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../profile.js")>()),
  syncMatrixOwnProfile: deps.syncMatrixOwnProfile,
}));
vi.mock("./startup-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./startup-verification.js")>()),
  ensureMatrixStartupVerification: deps.ensureMatrixStartupVerification,
}));
vi.mock("../config-update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config-update.js")>()),
  updateMatrixAccountConfig: deps.updateMatrixAccountConfig,
}));
function createVerificationStatus(verified = false): MatrixOwnDeviceVerificationStatus {
  return {
    encryptionEnabled: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE",
    verified,
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
    serverDeviceKnown: true,
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
describe("runMatrixStartupMaintenance", () => {
  beforeEach(() => {
    deps.summarizeMatrixDeviceHealth.mockReset().mockReturnValue({
      currentDeviceId: null,
      staleOpenClawDevices: [],
      currentOpenClawDevices: [],
    });
    deps.syncMatrixOwnProfile.mockReset().mockResolvedValue(createProfileSyncResult());
    deps.ensureMatrixStartupVerification.mockReset().mockResolvedValue({
      kind: "verified",
      verification: createVerificationStatus(true),
    });
    deps.updateMatrixAccountConfig.mockReset().mockImplementation((cfg) => cfg);
  });
  function createParams(encryption = true): Parameters<typeof runMatrixStartupMaintenance>[0] {
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
        encryption,
      },
      accountId: "ops",
      effectiveAccountId: "ops",
      accountConfig: { name: "Ops Bot", avatarUrl: "https://example.org/avatar.png" },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
      getRuntimeConfig: vi.fn(() => ({ channels: { matrix: {} } })),
      replaceConfigFile: vi.fn(async () => {}),
      loadWebMedia: vi.fn(async () => ({
        buffer: Buffer.from("avatar"),
        contentType: "image/png",
        fileName: "avatar.png",
      })),
      env: {},
    };
  }
  it("persists converted avatar URLs after profile sync", async () => {
    const params = createParams(false);
    const updatedCfg = { channels: { matrix: { avatarUrl: "mxc://avatar" } } };
    deps.syncMatrixOwnProfile.mockResolvedValue(
      createProfileSyncResult({
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://avatar",
        uploadedAvatarSource: "http",
        convertedAvatarFromHttp: true,
      }),
    );
    deps.updateMatrixAccountConfig.mockReturnValue(updatedCfg);
    await runMatrixStartupMaintenance(params);
    expect(deps.syncMatrixOwnProfile).toHaveBeenCalledTimes(1);
    expect(deps.syncMatrixOwnProfile.mock.calls[0]?.[0]).toStrictEqual({
      client: params.client,
      userId: "@bot:example.org",
      displayName: "Ops Bot",
      avatarUrl: "https://example.org/avatar.png",
      loadAvatarFromUrl: params.loadWebMedia,
    });
    expect(deps.updateMatrixAccountConfig).toHaveBeenCalledWith(
      { channels: { matrix: {} } },
      "ops",
      { avatarUrl: "mxc://avatar" },
    );
    expect(params.replaceConfigFile).toHaveBeenCalledWith(updatedCfg as never);
    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: persisted converted avatar URL for account ops (mxc://avatar)",
    );
  });
  it("reports stale devices, pending verification, and restored legacy backups", async () => {
    const params = createParams();
    deps.summarizeMatrixDeviceHealth.mockReturnValue({
      currentDeviceId: null,
      staleOpenClawDevices: [
        { deviceId: "DEV123", displayName: "OpenClaw Device", current: false },
      ],
      currentOpenClawDevices: [],
    });
    deps.ensureMatrixStartupVerification.mockResolvedValue({
      kind: "pending",
      verification: createVerificationStatus(),
    });
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
  });
  it("logs cooldown and request-failure verification outcomes without throwing", async () => {
    const params = createParams();
    deps.ensureMatrixStartupVerification.mockResolvedValueOnce({
      kind: "cooldown",
      retryAfterMs: 321,
      verification: createVerificationStatus(),
    });
    await runMatrixStartupMaintenance(params);
    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: skipped startup verification request due to cooldown (retryAfterMs=321)",
    );
    deps.ensureMatrixStartupVerification.mockResolvedValueOnce({
      kind: "request-failed",
      error: "boom",
      verification: createVerificationStatus(),
    });
    await runMatrixStartupMaintenance(params);
    expect(params.logger.debug).toHaveBeenCalledWith(
      "Matrix startup verification request failed (non-fatal)",
      { error: "boom" },
    );
  });
  it("aborts maintenance before later startup steps continue", async () => {
    const params = createParams();
    const abortController = new AbortController();
    params.abortSignal = abortController.signal;
    deps.syncMatrixOwnProfile.mockImplementation(async () => {
      abortController.abort();
      return createProfileSyncResult();
    });
    const result = runMatrixStartupMaintenance(params);
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "Matrix startup aborted",
    });
    expect(deps.ensureMatrixStartupVerification).not.toHaveBeenCalled();
  });
});
