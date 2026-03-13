import { vi } from "vitest";

type MatrixBotSdkMockParams = {
  matrixClient?: unknown;
  simpleFsStorageProvider?: unknown;
  rustSdkCryptoStorageProvider?: unknown;
  includeVerboseLogService?: boolean;
};

export function createMatrixBotSdkMock(params: MatrixBotSdkMockParams = {}) {
  return {
    ConsoleLogger: class {
      trace = vi.fn();
      debug = vi.fn();
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
    MatrixClient: params.matrixClient ?? class {},
    LogService: {
      setLogger: vi.fn(),
      ...(params.includeVerboseLogService
        ? {
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
          }
        : {}),
    },
    SimpleFsStorageProvider: params.simpleFsStorageProvider ?? class {},
    RustSdkCryptoStorageProvider: params.rustSdkCryptoStorageProvider ?? class {},
  };
}
