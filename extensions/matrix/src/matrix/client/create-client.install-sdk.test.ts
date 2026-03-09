import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureMatrixSdkInstalled: vi.fn(),
  getChildLogger: vi.fn(),
  loadMatrixSdk: vi.fn(),
  mkdirSync: vi.fn(),
  maybeMigrateLegacyStorage: vi.fn(),
  resolveMatrixStoragePaths: vi.fn(),
  writeStorageMeta: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: mocks.mkdirSync,
  },
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    logging: {
      getChildLogger: mocks.getChildLogger,
    },
  }),
}));

vi.mock("../deps.js", () => ({
  ensureMatrixSdkInstalled: mocks.ensureMatrixSdkInstalled,
}));

vi.mock("../sdk-runtime.js", () => ({
  loadMatrixSdk: mocks.loadMatrixSdk,
}));

vi.mock("./storage.js", () => ({
  maybeMigrateLegacyStorage: mocks.maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths: mocks.resolveMatrixStoragePaths,
  writeStorageMeta: mocks.writeStorageMeta,
}));

const { createMatrixClient } = await import("./create-client.js");

describe("createMatrixClient", () => {
  beforeEach(() => {
    mocks.ensureMatrixSdkInstalled.mockReset();
    mocks.getChildLogger.mockReset();
    mocks.loadMatrixSdk.mockReset();
    mocks.mkdirSync.mockReset();
    mocks.maybeMigrateLegacyStorage.mockReset();
    mocks.resolveMatrixStoragePaths.mockReset();
    mocks.writeStorageMeta.mockReset();

    mocks.getChildLogger.mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    mocks.resolveMatrixStoragePaths.mockReturnValue({
      rootDir: "/tmp/matrix-root",
      storagePath: "/tmp/matrix-store.json",
      cryptoPath: "/tmp/matrix-crypto",
    });
  });

  it("ensures the matrix SDK is installed before loading it", async () => {
    const order: string[] = [];

    class FakeMatrixClient {
      crypto = undefined;
      constructor(
        _homeserver: string,
        _accessToken: string,
        _storage?: unknown,
        _cryptoStorage?: unknown,
      ) {}
    }

    class FakeStorageProvider {
      constructor(_storagePath: string) {}
    }

    class FakeCryptoStorageProvider {
      constructor(_cryptoPath: string, _storeType: unknown) {}
    }

    class FakeConsoleLogger {
      trace() {}
      debug() {}
      info() {}
      warn() {}
      error() {}
    }

    mocks.ensureMatrixSdkInstalled.mockImplementation(async () => {
      order.push("ensure");
    });
    mocks.loadMatrixSdk.mockImplementation(() => {
      order.push("load");
      return {
        MatrixClient: FakeMatrixClient,
        SimpleFsStorageProvider: FakeStorageProvider,
        RustSdkCryptoStorageProvider: FakeCryptoStorageProvider,
        ConsoleLogger: FakeConsoleLogger,
        LogService: {
          setLogger: vi.fn(),
          warn: vi.fn(),
        },
      };
    });

    await createMatrixClient({
      homeserver: "https://matrix.example.com",
      userId: "@lobster:example.com",
      accessToken: "tok",
    });

    expect(order[0]).toBe("ensure");
    expect(order.slice(1)).toEqual(["load", "load"]);
    expect(mocks.ensureMatrixSdkInstalled).toHaveBeenCalledWith({
      log: expect.any(Function),
    });
  });
});
