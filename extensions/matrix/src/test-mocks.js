import { vi } from "vitest";
function createMatrixBotSdkMock(params = {}) {
  return {
    ConsoleLogger: class {
      constructor() {
        this.trace = vi.fn();
        this.debug = vi.fn();
        this.info = vi.fn();
        this.warn = vi.fn();
        this.error = vi.fn();
      }
    },
    MatrixClient: params.matrixClient ?? class {
    },
    LogService: {
      setLogger: vi.fn(),
      ...params.includeVerboseLogService ? {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      } : {}
    },
    SimpleFsStorageProvider: params.simpleFsStorageProvider ?? class {
    },
    RustSdkCryptoStorageProvider: params.rustSdkCryptoStorageProvider ?? class {
    }
  };
}
export {
  createMatrixBotSdkMock
};
