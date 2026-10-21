import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { assertMatrixQaCliBackupRestoreFailed } from "./scenario-runtime-e2ee-destructive-recovery.js";
import { mutateMatrixQaCliStateLoss } from "./scenario-runtime-e2ee-state.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";

const mocks = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
  createMatrixQaE2eeScenarioClient: vi.fn(),
  createMatrixQaRecoveryCliRuntime: vi.fn(),
  loginMatrixQaRecoveryDevice: vi.fn(),
  runMatrixQaCliJson: vi.fn(),
  createMatrixQaDriverScenarioClient: vi.fn(),
  readMatrixQaGatewayMatrixAccount: vi.fn(),
  replaceMatrixQaGatewayMatrixAccount: vi.fn(),
  waitForMatrixSyncStoreWithCursor: vi.fn(),
  deleteMatrixSyncStoreCursor: vi.fn(),
}));

const storageMetadataRuntime = vi.hoisted(() => ({
  normalizeMatrixStorageMetadata(value: unknown) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const metadata = value as { deviceId?: unknown; userId?: unknown };
    return {
      ...(typeof metadata.deviceId === "string" ? { deviceId: metadata.deviceId } : {}),
      ...(typeof metadata.userId === "string" ? { userId: metadata.userId } : {}),
    };
  },
  openMatrixStorageMetaStoreOptions(storageRootDir: string) {
    return {
      namespace: "storage-meta",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: storageRootDir },
    };
  },
}));

// mock-isolation: Recovery scenarios use synthetic clients, not live Matrix accounts.
vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: mocks.createMatrixQaClient,
}));

// mock-isolation: Keep crypto admission and storage metadata inside the synthetic fixture.
vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: mocks.createMatrixQaE2eeScenarioClient,
  loadMatrixQaE2eeRuntime: async () => ({
    ...storageMetadataRuntime,
    openMatrixRecoveryKeyStoreOptions: (storageRootDir: string) => ({
      namespace: "recovery-key",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: storageRootDir },
    }),
  }),
}));

vi.mock("./scenario-runtime-e2ee-destructive-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-e2ee-destructive-recovery.js")>()),
  createMatrixQaRecoveryCliRuntime: mocks.createMatrixQaRecoveryCliRuntime,
  loginMatrixQaRecoveryDevice: mocks.loginMatrixQaRecoveryDevice,
  runMatrixQaCliJson: mocks.runMatrixQaCliJson,
}));

vi.mock("./scenario-runtime-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-shared.js")>()),
  createMatrixQaDriverScenarioClient: mocks.createMatrixQaDriverScenarioClient,
}));

// mock-isolation: Account replacement must target fixture state, not an operator Gateway.
vi.mock("./scenario-runtime-config.js", () => ({
  readMatrixQaGatewayMatrixAccount: mocks.readMatrixQaGatewayMatrixAccount,
  replaceMatrixQaGatewayMatrixAccount: mocks.replaceMatrixQaGatewayMatrixAccount,
}));

// mock-isolation: Exercise cursor recovery without waiting for a live Matrix sync store.
vi.mock("./scenario-runtime-state-files.js", () => ({
  waitForMatrixSyncStoreWithCursor: mocks.waitForMatrixSyncStoreWithCursor,
  deleteMatrixSyncStoreCursor: mocks.deleteMatrixSyncStoreCursor,
}));

import {
  runMatrixQaE2eeHistoryExistsBackupEmptyScenario,
  runMatrixQaE2eeServerDeviceDeletedLocalStateIntactScenario,
  runMatrixQaE2eeStaleRecoveryKeyAfterBackupResetScenario,
  runMatrixQaE2eeStateLossExternalRecoveryKeyScenario,
  runMatrixQaE2eeSyncStateLossCryptoIntactScenario,
  runMatrixQaE2eeWrongAccountRecoveryKeyScenario,
} from "./scenario-runtime-e2ee-destructive.js";

function createDisposableOwner(label: string, cleanupOrder: string[], failCleanup = false) {
  const recordCleanup = (action: string, error: string) => {
    cleanupOrder.push(`${label}:${action}`);
    if (failCleanup) {
      throw new Error(`${label} ${error} failed`);
    }
  };
  return {
    bootstrapOwnDeviceVerification: vi.fn(async () => ({
      success: true,
      verification: {
        backupVersion: `${label}-backup`,
        crossSigningVerified: true,
        verified: true,
      },
    })),
    deleteOwnDevices: vi.fn(async (deviceIds: string[]) => {
      recordCleanup(`delete:${deviceIds.join(",")}`, "device cleanup");
      return {};
    }),
    getRecoveryKey: vi.fn(async () => ({
      encodedPrivateKey: `${label}-recovery-key`,
      keyId: `${label}-key`,
    })),
    sendTextMessage: vi.fn(async () => `$${label}-seed`),
    stop: vi.fn(async () => recordCleanup("stop", "stop")),
  };
}

function account(label: string, deviceId = `${label.toUpperCase()}-DEVICE`) {
  return {
    accessToken: `${label}-token`,
    deviceId,
    password: `${label}-password`,
    userId: `@${label}:matrix-qa.test`,
  };
}

function createWrongAccountContext() {
  return new Proxy(createMatrixQaE2eeTestContext(), {
    get(target, property, receiver) {
      if (typeof property === "string" && property.startsWith("observer")) {
        throw new Error(`observer credential read: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("awaits target room sync before sending", async () => {
  const order: string[] = [];
  const replacement = account("replacement", "REPLACEMENT");
  const roomId = "!recovery:matrix-qa.test";
  const driver = {
    prime: vi.fn(async () => "driver-cursor"),
    waitForJoinedMember: vi.fn(async () => {
      order.push("wait");
      await Promise.resolve();
      order.push("synced");
    }),
    sendTextMessage: vi.fn(async () => {
      order.push("send");
      throw new Error("send reached");
    }),
    stop: vi.fn(async () => {}),
  };
  mocks.createMatrixQaClient.mockReturnValue({
    registerWithToken: vi.fn(async () => replacement),
    joinRoom: vi.fn(async () => {}),
  });
  mocks.createMatrixQaDriverScenarioClient.mockReturnValue({
    createPrivateRoom: vi.fn(async () => roomId),
    primeRoom: vi.fn(async () => "raw-cursor"),
  });
  mocks.createMatrixQaE2eeScenarioClient.mockResolvedValue(driver);
  mocks.readMatrixQaGatewayMatrixAccount.mockResolvedValue({ enabled: true });
  mocks.waitForMatrixSyncStoreWithCursor.mockResolvedValue({
    cursor: "saved-cursor",
    pathname: "/tmp/unused-sync-store",
    stateKey: "saved",
  });
  const context = createMatrixQaE2eeTestContext({
    gatewayStateDir: "/tmp/unused-gateway-state",
    gatewayRuntimeEnv: { OPENCLAW_CONFIG_PATH: "/tmp/unused-gateway-config" },
    restartGatewayAfterStateMutation: async (mutate) => {
      await mutate({ stateDir: "/tmp/unused-gateway-state" });
    },
    waitGatewayAccountReady: async () => {
      order.push("ready");
    },
  });

  await expect(runMatrixQaE2eeSyncStateLossCryptoIntactScenario(context)).rejects.toThrow(
    "send reached",
  );
  expect(driver.waitForJoinedMember).toHaveBeenCalledWith({
    roomId,
    timeoutMs: context.timeoutMs,
    userId: replacement.userId,
  });
  expect(order).toEqual(["ready", "wait", "synced", "send"]);
  expect(driver.stop).toHaveBeenCalledOnce();
  expect(mocks.replaceMatrixQaGatewayMatrixAccount).toHaveBeenLastCalledWith(
    expect.objectContaining({ accountId: "sut", accountConfig: { enabled: true } }),
  );
});
it.each(["deviceId", "userId"] as const)(
  "selects SQLite account metadata without deleting a different %s",
  async (field) => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-storage-"));
    try {
      const accountRoot = path.join(stateDir, "matrix", "accounts", "zz-target", "server", "token");
      const otherRoot = path.join(stateDir, "matrix", "accounts", "aa-other", "server", "token");
      const otherMetadata = {
        deviceId: "DEVICE",
        userId: "@owner:matrix-qa.test",
        [field]: "OTHER",
      };
      createPluginStateSyncKeyedStoreForTests(
        "matrix",
        storageMetadataRuntime.openMatrixStorageMetaStoreOptions(accountRoot),
      ).register("current", { deviceId: "DEVICE", userId: "@owner:matrix-qa.test" });
      createPluginStateSyncKeyedStoreForTests(
        "matrix",
        storageMetadataRuntime.openMatrixStorageMetaStoreOptions(otherRoot),
      ).register("current", otherMetadata);
      resetPluginStateStoreForTests();

      await expect(
        mutateMatrixQaCliStateLoss({
          deviceId: "DEVICE",
          preserveRecoveryKey: false,
          runtime: { stateDir },
          userId: "@owner:matrix-qa.test",
        }),
      ).resolves.toMatchObject({ accountRoot });
      expect(
        createPluginStateSyncKeyedStoreForTests(
          "matrix",
          storageMetadataRuntime.openMatrixStorageMetaStoreOptions(otherRoot),
        ).lookup("current"),
      ).toEqual(otherMetadata);
    } finally {
      resetPluginStateStoreForTests();
      await rm(stateDir, { force: true, recursive: true });
    }
  },
);

it.each([
  { name: "external key", run: runMatrixQaE2eeStateLossExternalRecoveryKeyScenario },
  { name: "stale key", run: runMatrixQaE2eeStaleRecoveryKeyAfterBackupResetScenario },
  { name: "empty backup", run: runMatrixQaE2eeHistoryExistsBackupEmptyScenario },
  { name: "deleted device", run: runMatrixQaE2eeServerDeviceDeletedLocalStateIntactScenario },
])("releases $name resources when recovery runtime construction fails", async ({ run }) => {
  const cleanupOrder: string[] = [];
  const failure = new Error("runtime construction failed");
  const owner = {
    ...createDisposableOwner("owner", cleanupOrder),
    resetRoomKeyBackup: vi.fn(async () => ({ success: true, createdVersion: "fresh-backup" })),
  };
  owner.getRecoveryKey
    .mockResolvedValueOnce({ encodedPrivateKey: "owner-recovery-key", keyId: "owner-key" })
    .mockResolvedValue({ encodedPrivateKey: "fresh-recovery-key", keyId: "fresh-key" });
  mocks.createMatrixQaClient.mockReturnValue({
    registerWithToken: async () => account("owner", "OWNER"),
    createPrivateRoom: async () => "!owner:matrix-qa.test",
    loginWithPassword: mocks.loginMatrixQaRecoveryDevice,
  });
  mocks.createMatrixQaE2eeScenarioClient.mockResolvedValue(owner);
  mocks.loginMatrixQaRecoveryDevice.mockResolvedValue({
    accessToken: "recovery-token",
    deviceId: "RECOVERY",
    userId: "@owner:matrix-qa.test",
  });
  mocks.createMatrixQaRecoveryCliRuntime.mockRejectedValueOnce(failure);
  await expect(run(createMatrixQaE2eeTestContext({ gatewayRuntimeEnv: {} }))).rejects.toBe(failure);
  expect(cleanupOrder).toEqual(["owner:stop", "owner:delete:RECOVERY"]);
});

it("checks deleted-device status before releasing its disposable recovery runtime", async () => {
  const cleanupOrder: string[] = [];
  const owner = {
    ...createDisposableOwner("owner", cleanupOrder),
    listOwnDevices: vi.fn(async () => []),
  };
  const dispose = vi.fn(async () => {
    cleanupOrder.push("cli:dispose");
  });
  mocks.createMatrixQaClient.mockReturnValue({
    registerWithToken: async () => account("owner", "OWNER"),
    createPrivateRoom: async () => "!owner:matrix-qa.test",
  });
  mocks.createMatrixQaE2eeScenarioClient.mockResolvedValue(owner);
  mocks.loginMatrixQaRecoveryDevice.mockResolvedValue({
    accessToken: "recovery-token",
    deviceId: "RECOVERY",
    userId: "@owner:matrix-qa.test",
  });
  mocks.createMatrixQaRecoveryCliRuntime.mockResolvedValue({ dispose });
  mocks.runMatrixQaCliJson
    .mockReset()
    .mockResolvedValueOnce({
      payload: { success: true, backup: { matchesDecryptionKey: true } },
      result: { exitCode: 0 },
    })
    .mockResolvedValueOnce({ payload: { error: "M_UNKNOWN_TOKEN" }, result: { exitCode: 1 } })
    .mockResolvedValueOnce({ payload: { serverDeviceKnown: false }, result: { exitCode: 0 } });

  const result = await runMatrixQaE2eeServerDeviceDeletedLocalStateIntactScenario(
    createMatrixQaE2eeTestContext({ gatewayRuntimeEnv: {} }),
  );

  expect(result.details).toContain("deleted device: RECOVERY");
  expect(result.details).toContain("default status exit code: 1");
  expect(result.details).toContain("degraded status exit code: 0");
  expect(result.details).toContain("device present on server: no");
  expect(mocks.runMatrixQaCliJson.mock.calls.slice(1).map(([call]) => call.args)).toEqual([
    ["matrix", "verify", "status", "--account", "deleted-device", "--json"],
    [
      "matrix",
      "verify",
      "status",
      "--account",
      "deleted-device",
      "--allow-degraded-local-state",
      "--json",
    ],
  ]);
  expect(cleanupOrder).toEqual([
    "owner:delete:RECOVERY",
    "owner:stop",
    "cli:dispose",
    "owner:stop",
    "owner:delete:RECOVERY",
  ]);
});

it("uses disposable source and target owners without reading observer credentials", async () => {
  const cleanupOrder: string[] = [];
  const sourceOwner = createDisposableOwner("source", cleanupOrder, true);
  const targetOwner = createDisposableOwner("target", cleanupOrder, true);
  const registerWithToken = vi
    .fn()
    .mockResolvedValueOnce(account("source"))
    .mockResolvedValueOnce(account("target"));
  mocks.createMatrixQaClient.mockReturnValue({
    createPrivateRoom: vi
      .fn()
      .mockResolvedValueOnce("!source:matrix-qa.test")
      .mockResolvedValueOnce("!target:matrix-qa.test"),
    registerWithToken,
  });
  mocks.createMatrixQaE2eeScenarioClient
    .mockResolvedValueOnce(sourceOwner)
    .mockResolvedValueOnce(targetOwner);
  mocks.loginMatrixQaRecoveryDevice.mockResolvedValue({
    accessToken: "target-recovery-token",
    deviceId: "TARGET-RECOVERY-DEVICE",
    userId: "@target:matrix-qa.test",
  });
  mocks.createMatrixQaRecoveryCliRuntime.mockResolvedValue({
    dispose: vi.fn(async () => {
      cleanupOrder.push("cli:dispose");
      throw new Error("CLI cleanup failed");
    }),
  });
  mocks.runMatrixQaCliJson.mockResolvedValue({
    payload: {
      backup: { decryptionKeyCached: false, keyLoadError: "bad MAC", matchesDecryptionKey: false },
      backupVersion: "target-backup",
      error: "bad MAC",
      success: false,
    },
    result: { exitCode: 1 },
  });

  const result = await runMatrixQaE2eeWrongAccountRecoveryKeyScenario(createWrongAccountContext());

  expect(registerWithToken).toHaveBeenCalledTimes(2);
  expect(mocks.createMatrixQaE2eeScenarioClient).toHaveBeenCalledTimes(2);
  expect(mocks.loginMatrixQaRecoveryDevice).toHaveBeenCalledWith(
    expect.objectContaining({ password: "target-password", userId: "@target:matrix-qa.test" }),
  );
  expect(mocks.runMatrixQaCliJson).toHaveBeenCalledWith(
    expect.objectContaining({ stdin: "source-recovery-key\n" }),
  );
  expect(result.details).toContain("restore exit code: 1");
  expect(result.details).toContain("restore error: bad MAC");
  expect(cleanupOrder).toEqual([
    "cli:dispose",
    "target:delete:TARGET-RECOVERY-DEVICE",
    "target:stop",
    "source:stop",
  ]);
});

it.each([
  [0, "missing-recovery-key", "backup key unavailable", "returned a successful exit code"],
  [
    1,
    "missing-recovery-key",
    "network unavailable",
    "without the expected missing-recovery-key diagnostic",
  ],
  [
    1,
    "rejected-recovery-key",
    "backup key mismatch",
    "without the expected rejected-recovery-key diagnostic",
  ],
] as const)("rejects exit %s / %s with %s", (exitCode, failureKind, error, rejection) => {
  const backup =
    failureKind === "missing-recovery-key"
      ? { decryptionKeyCached: false }
      : { matchesDecryptionKey: false };
  const assertRestore = () =>
    assertMatrixQaCliBackupRestoreFailed(
      { payload: { backup, backupVersion: "1", error, success: false }, result: { exitCode } },
      { expectedBackupVersion: "1", failureKind, label: "restore" },
    );
  expect(assertRestore).toThrow(rejection);
});
