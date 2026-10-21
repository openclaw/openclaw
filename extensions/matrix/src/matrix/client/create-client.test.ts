import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { createMatrixClient } from "./create-client.js";

const mocks = vi.hoisted(() => ({
  ensureMatrixSdkLoggingConfigured: vi.fn(),
  resolveValidatedMatrixHomeserverUrl: vi.fn(),
  maybeMigrateLegacyStorage: vi.fn(async () => undefined),
  resolveMatrixStoragePaths: vi.fn(),
  writeStorageMeta: vi.fn(),
  createSyncStore: vi.fn(),
  MatrixClient: vi.fn(),
  state: { resolveStateDir: vi.fn() },
}));
const preparedSyncStore = {};
// mock-isolation: Client construction uses a synthetic runtime rather than shared Gateway state.
vi.mock("../../runtime.js", () => ({ getMatrixRuntime: () => ({ state: mocks.state }) }));
// mock-isolation: Constructor wiring must not reconfigure the process-wide SDK logger.
vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: mocks.ensureMatrixSdkLoggingConfigured,
}));
// mock-isolation: Homeserver validation is controlled without resolving external hosts.
vi.mock("./config.js", () => ({
  resolveValidatedMatrixHomeserverUrl: mocks.resolveValidatedMatrixHomeserverUrl,
}));
// mock-isolation: Observe migration and metadata wiring without persisting account state.
vi.mock("./storage.js", () => ({
  maybeMigrateLegacyStorage: mocks.maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths: mocks.resolveMatrixStoragePaths,
  writeStorageMeta: mocks.writeStorageMeta,
}));
// mock-isolation: Hydration is explicitly gated without opening a real sync database.
vi.mock("./file-sync-store.js", () => ({
  SqliteBackedMatrixSyncStore: { create: mocks.createSyncStore },
}));
// mock-isolation: Observe constructor options without starting real SDK transports.
vi.mock("../sdk.js", () => ({ MatrixClient: mocks.MatrixClient }));

const storagePaths = {
  rootDir: "/tmp/openclaw-matrix-create-client-test",
  recoveryKeyPath: "/tmp/openclaw-matrix-create-client-test/recovery.key",
  idbSnapshotPath: "/tmp/openclaw-matrix-create-client-test/idb.snapshot",
  accountKey: "default",
  tokenHash: "token-hash",
};

const auth = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "tok",
};
const clientOptions = {
  userId: auth.userId,
  password: undefined,
  deviceId: undefined,
  encryption: undefined,
  localTimeoutMs: undefined,
  initialSyncLimit: undefined,
  syncStore: undefined,
  recoveryKeyPath: undefined,
  idbSnapshotPath: undefined,
  cryptoDatabasePrefix: undefined,
  autoBootstrapCrypto: undefined,
  ssrfPolicy: undefined,
  dispatcherPolicy: undefined,
  stateRuntime: mocks.state,
};
const expectClient = (options: { [K in keyof typeof clientOptions]?: unknown } = {}) =>
  expect(mocks.MatrixClient).toHaveBeenCalledWith(auth.homeserver, auth.accessToken, {
    ...clientOptions,
    ...options,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSyncStore.mockResolvedValue(preparedSyncStore);
  mocks.resolveValidatedMatrixHomeserverUrl.mockResolvedValue(auth.homeserver);
  mocks.resolveMatrixStoragePaths.mockReturnValue(storagePaths);
  mocks.MatrixClient.mockImplementation(function MockMatrixClient() {
    return { stop: vi.fn() };
  });
});

it("persists storage metadata by default", async () => {
  await createMatrixClient(auth);

  expect(mocks.writeStorageMeta).toHaveBeenCalledWith({
    storagePaths,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accountId: undefined,
    deviceId: undefined,
  });
  expect(mocks.resolveMatrixStoragePaths).toHaveBeenCalledTimes(1);
  expectClient({
    syncStore: preparedSyncStore,
    recoveryKeyPath: storagePaths.recoveryKeyPath,
    idbSnapshotPath: storagePaths.idbSnapshotPath,
    cryptoDatabasePrefix: "openclaw-matrix-default-token-hash",
  });
});

it("loads persisted sync state before constructing or returning the client", async () => {
  const hydration = createDeferred<typeof preparedSyncStore>();
  mocks.createSyncStore.mockReturnValue(hydration.promise);
  const pending = createMatrixClient(auth);
  await vi.waitFor(() => expect(mocks.createSyncStore).toHaveBeenCalled());
  expect(mocks.MatrixClient).not.toHaveBeenCalled();
  hydration.resolve(preparedSyncStore);
  await pending;
  expect(mocks.MatrixClient).toHaveBeenCalledWith(
    "https://matrix.example.org",
    "tok",
    expect.objectContaining({ syncStore: preparedSyncStore }),
  );
});

const explicitPolicy = { allowPrivateNetwork: true, customField: "test" };
it.each([
  ["derives private-network policy", { allowPrivateNetwork: true }, { allowPrivateNetwork: true }],
  [
    "prefers explicit policy",
    { allowPrivateNetwork: false, ssrfPolicy: explicitPolicy },
    explicitPolicy,
  ],
  ["leaves policy unset", {}, undefined],
] as const)("skips persistent storage and %s", async (_name, options, ssrfPolicy) => {
  await createMatrixClient({ ...auth, persistStorage: false, ...options });
  expect(mocks.resolveMatrixStoragePaths).not.toHaveBeenCalled();
  expect(mocks.writeStorageMeta).not.toHaveBeenCalled();
  expectClient({ ssrfPolicy });
});
