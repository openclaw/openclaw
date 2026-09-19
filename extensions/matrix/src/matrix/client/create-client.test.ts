// Matrix tests cover create client plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ensureMatrixSdkLoggingConfiguredMock = vi.hoisted(() => vi.fn());
const resolveValidatedMatrixHomeserverUrlMock = vi.hoisted(() => vi.fn());
const maybeMigrateLegacyStorageMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveMatrixStoragePathsMock = vi.hoisted(() => vi.fn());
const writeStorageMetaMock = vi.hoisted(() => vi.fn());
const createSyncStoreMock = vi.hoisted(() => vi.fn());
const preparedSyncStore = vi.hoisted(() => ({ hasSavedSyncFromCleanShutdown: () => true }));
const MatrixClientMock = vi.hoisted(() => vi.fn());
const stateRuntimeMock = vi.hoisted(() => ({
  resolveStateDir: vi.fn(),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({ state: stateRuntimeMock }),
}));

vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: ensureMatrixSdkLoggingConfiguredMock,
}));

vi.mock("./config.js", () => ({
  resolveValidatedMatrixHomeserverUrl: resolveValidatedMatrixHomeserverUrlMock,
}));

vi.mock("./storage.js", () => ({
  maybeMigrateLegacyStorage: maybeMigrateLegacyStorageMock,
  resolveMatrixStoragePaths: resolveMatrixStoragePathsMock,
  writeStorageMeta: writeStorageMetaMock,
}));

vi.mock("./file-sync-store.js", () => ({
  SqliteBackedMatrixSyncStore: { create: createSyncStoreMock },
}));

vi.mock("../sdk.js", () => ({
  MatrixClient: MatrixClientMock,
}));

let createMatrixClient: typeof import("./create-client.js").createMatrixClient;

describe("createMatrixClient", () => {
  const storagePaths = {
    rootDir: "/tmp/openclaw-matrix-create-client-test",
    storagePath: "/tmp/openclaw-matrix-create-client-test/storage.json",
    recoveryKeyPath: "/tmp/openclaw-matrix-create-client-test/recovery.key",
    idbSnapshotPath: "/tmp/openclaw-matrix-create-client-test/idb.snapshot",
    accountKey: "default",
    tokenHash: "token-hash",
  };

  beforeAll(async () => {
    ({ createMatrixClient } = await import("./create-client.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createSyncStoreMock.mockResolvedValue(preparedSyncStore);
    ensureMatrixSdkLoggingConfiguredMock.mockReturnValue(undefined);
    resolveValidatedMatrixHomeserverUrlMock.mockResolvedValue("https://matrix.example.org");
    resolveMatrixStoragePathsMock.mockReturnValue(storagePaths);
    MatrixClientMock.mockImplementation(function MockMatrixClient() {
      return {
        stop: vi.fn(),
      };
    });
  });

  it("persists storage metadata by default", async () => {
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
    });

    expect(writeStorageMetaMock).toHaveBeenCalledWith({
      storagePaths,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accountId: undefined,
      deviceId: undefined,
    });
    expect(resolveMatrixStoragePathsMock).toHaveBeenCalledTimes(1);
    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
      password: undefined,
      deviceId: undefined,
      encryption: undefined,
      localTimeoutMs: undefined,
      initialSyncLimit: undefined,
      syncStore: preparedSyncStore,
      recoveryKeyPath: storagePaths.recoveryKeyPath,
      idbSnapshotPath: storagePaths.idbSnapshotPath,
      cryptoDatabasePrefix: "openclaw-matrix-default-token-hash",
      autoBootstrapCrypto: undefined,
      ssrfPolicy: undefined,
      dispatcherPolicy: undefined,
      stateRuntime: stateRuntimeMock,
    });
  });

  it("loads the persisted replay decision before constructing or returning the client", async () => {
    const hydration = createDeferred<typeof preparedSyncStore>();
    createSyncStoreMock.mockReturnValue(hydration.promise);
    const pending = createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
    });
    await vi.waitFor(() => expect(createSyncStoreMock).toHaveBeenCalled());
    expect(MatrixClientMock).not.toHaveBeenCalled();
    hydration.resolve(preparedSyncStore);
    await pending;
    expect(MatrixClientMock).toHaveBeenCalledWith(
      "https://matrix.example.org",
      "tok",
      expect.objectContaining({ syncStore: preparedSyncStore }),
    );
  });

  it("derives ssrfPolicy from allowPrivateNetwork when no explicit policy is provided", async () => {
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
      allowPrivateNetwork: true,
    });

    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
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
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy: undefined,
      stateRuntime: stateRuntimeMock,
    });
  });

  it("prefers explicit ssrfPolicy over allowPrivateNetwork", async () => {
    const explicitPolicy = { allowPrivateNetwork: true, customField: "test" };
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
      allowPrivateNetwork: false,
      ssrfPolicy: explicitPolicy as never,
    });

    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
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
      ssrfPolicy: explicitPolicy,
      dispatcherPolicy: undefined,
      stateRuntime: stateRuntimeMock,
    });
  });

  it("leaves ssrfPolicy undefined when allowPrivateNetwork is falsy and no explicit policy", async () => {
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
    });

    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
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
      stateRuntime: stateRuntimeMock,
    });
  });

  it("skips persistent storage wiring when persistence is disabled", async () => {
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
    });

    expect(resolveMatrixStoragePathsMock).not.toHaveBeenCalled();
    expect(writeStorageMetaMock).not.toHaveBeenCalled();
    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
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
      stateRuntime: stateRuntimeMock,
    });
  });
});
