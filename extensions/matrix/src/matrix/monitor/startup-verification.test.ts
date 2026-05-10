import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMatrixStartupVerification } from "./startup-verification.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "matrix-startup-verify-"));
}

function createAuth(accountId = "default") {
  return {
    accountId,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    encryption: true,
  };
}

type VerificationSummaryLike = {
  id: string;
  transactionId?: string;
  isSelfVerification: boolean;
  completed: boolean;
  pending: boolean;
};

function createHarness(params?: {
  verified?: boolean;
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
  requestVerification?: () => Promise<{ id: string; transactionId?: string }>;
  listVerifications?: () => Promise<VerificationSummaryLike[]>;
}) {
  const requestVerification =
    params?.requestVerification ??
    (async () => ({
      id: "verification-1",
      transactionId: "txn-1",
    }));
  const listVerifications = params?.listVerifications ?? (async () => []);
  const getOwnDeviceVerificationStatus = vi.fn(async () => ({
    encryptionEnabled: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE123",
    verified: params?.verified === true,
    localVerified: params?.localVerified ?? params?.verified === true,
    crossSigningVerified: params?.crossSigningVerified ?? params?.verified === true,
    signedByOwner: params?.signedByOwner ?? params?.verified === true,
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
  }));
  return {
    client: {
      getOwnDeviceVerificationStatus,
      crypto: {
        listVerifications: vi.fn(listVerifications),
        requestVerification: vi.fn(requestVerification),
      },
    },
    getOwnDeviceVerificationStatus,
  };
}

describe("ensureMatrixStartupVerification", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("skips automatic requests when the device is already verified", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({ verified: true });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
    });

    expect(result.kind).toBe("verified");
    expect(harness.client.crypto.requestVerification).not.toHaveBeenCalled();
  });

  it("still requests startup verification when trust is only local", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({
      verified: false,
      localVerified: true,
      crossSigningVerified: false,
      signedByOwner: false,
    });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
    });

    expect(result.kind).toBe("requested");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
  });

  it("skips automatic requests when a self verification is already pending", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({
      listVerifications: async () => [
        {
          id: "verification-1",
          transactionId: "txn-1",
          isSelfVerification: true,
          completed: false,
          pending: true,
        },
      ],
    });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
    });

    expect(result.kind).toBe("pending");
    expect(harness.client.crypto.requestVerification).not.toHaveBeenCalled();
  });

  it("respects the startup verification cooldown", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness();
    const initialNowMs = Date.parse("2026-03-08T12:00:00.000Z");
    await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
      nowMs: initialNowMs,
    });
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);

    const second = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
      nowMs: initialNowMs + 60_000,
    });

    expect(second.kind).toBe("cooldown");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
  });

  it("supports disabling startup verification requests", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness();
    const stateRootDir = tempHome;
    await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir,
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {
        startupVerification: "off",
      },
      stateRootDir,
    });

    expect(result.kind).toBe("disabled");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
  });

  it("persists a successful startup verification request", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness();

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });

    expect(result.kind).toBe("requested");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
  });

  it("keeps startup verification failures non-fatal", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({
      requestVerification: async () => {
        throw new Error("no other verified session");
      },
    });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
    });

    expect(result.kind).toBe("request-failed");
    if (result.kind !== "request-failed") {
      throw new Error(`Unexpected startup verification result: ${result.kind}`);
    }
    expect(result.error).toContain("no other verified session");

    const cooledDown = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir: tempHome,
      nowMs: Date.now() + 60_000,
    });

    expect(cooledDown.kind).toBe("cooldown");
  });

  it("retries failed startup verification requests sooner than successful ones", async () => {
    const tempHome = createTempStateDir();
    const stateRootDir = tempHome;
    const failingHarness = createHarness({
      requestVerification: async () => {
        throw new Error("no other verified session");
      },
    });

    await ensureMatrixStartupVerification({
      client: failingHarness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir,
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });

    const retryingHarness = createHarness();
    const result = await ensureMatrixStartupVerification({
      client: retryingHarness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir,
      nowMs: Date.parse("2026-03-08T13:30:00.000Z"),
    });

    expect(result.kind).toBe("requested");
    expect(retryingHarness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
  });

  it("clears the persisted startup state after verification succeeds", async () => {
    const tempHome = createTempStateDir();
    const stateRootDir = tempHome;
    const unverified = createHarness();

    await ensureMatrixStartupVerification({
      client: unverified.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir,
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });

    const verified = createHarness({ verified: true });
    const result = await ensureMatrixStartupVerification({
      client: verified.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateRootDir,
    });

    expect(result.kind).toBe("verified");
  });
});
