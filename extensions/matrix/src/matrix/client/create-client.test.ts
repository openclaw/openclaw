import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { createMatrixClient } from "./create-client.js";

const mocks = vi.hoisted(() => ({
  resolveValidatedMatrixHomeserverUrl: vi.fn(),
  maybeMigrateLegacyStorage: vi.fn(async () => undefined),
  resolveMatrixStoragePaths: vi.fn(),
  writeStorageMeta: vi.fn(),
  createSyncStore: vi.fn(),
  MatrixClient: vi.fn(),
  state: { resolveStateDir: vi.fn() },
}));
const preparedSyncStore = {};
// mock-isolation: Keep construction, logging, network validation, and storage synthetic.
vi.mock("../../runtime.js", () => ({ getMatrixRuntime: () => ({ state: mocks.state }) }));
// mock-isolation: Constructor wiring must not reconfigure the process-wide SDK logger.
vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: vi.fn(),
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

const auth = { homeserver: "https://matrix.test", userId: "@bot:matrix.test", accessToken: "tok" };
const expectClient = (options: Record<string, unknown>) =>
  expect(mocks.MatrixClient).toHaveBeenCalledWith(
    auth.homeserver,
    auth.accessToken,
    expect.objectContaining({ userId: auth.userId, stateRuntime: mocks.state, ...options }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSyncStore.mockResolvedValue(preparedSyncStore);
  mocks.resolveValidatedMatrixHomeserverUrl.mockResolvedValue(auth.homeserver);
  mocks.resolveMatrixStoragePaths.mockReturnValue(storagePaths);
});

it("persists metadata and hydrates sync state before constructing the client", async () => {
  const hydration = createDeferred<typeof preparedSyncStore>();
  mocks.createSyncStore.mockReturnValue(hydration.promise);
  const pending = createMatrixClient(auth);
  await vi.waitFor(() => expect(mocks.createSyncStore).toHaveBeenCalled());
  expect(mocks.MatrixClient).not.toHaveBeenCalled();
  expect(mocks.writeStorageMeta).toHaveBeenCalledBefore(mocks.createSyncStore);
  hydration.resolve(preparedSyncStore);
  await pending;
  expectClient({
    syncStore: preparedSyncStore,
    recoveryKeyPath: storagePaths.recoveryKeyPath,
    idbSnapshotPath: storagePaths.idbSnapshotPath,
    cryptoDatabasePrefix: "openclaw-matrix-default-token-hash",
  });
});

const policy = { allowPrivateNetwork: true, customField: "test" };
it.each([
  ["derives private-network policy", { allowPrivateNetwork: true }, { allowPrivateNetwork: true }],
  ["prefers explicit policy", { allowPrivateNetwork: false, ssrfPolicy: policy }, policy],
  ["leaves policy unset", {}, undefined],
] as const)("skips persistent storage and %s", async (_name, options, ssrfPolicy) => {
  await createMatrixClient({ ...auth, persistStorage: false, ...options });
  expect(mocks.resolveMatrixStoragePaths).not.toHaveBeenCalled();
  expect(mocks.writeStorageMeta).not.toHaveBeenCalled();
  expectClient({
    ssrfPolicy,
    syncStore: undefined,
    recoveryKeyPath: undefined,
    idbSnapshotPath: undefined,
    cryptoDatabasePrefix: undefined,
  });
});
