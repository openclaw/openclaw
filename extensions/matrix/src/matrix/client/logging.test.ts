import { logger as matrixJsSdkLogger } from "matrix-js-sdk/lib/logger.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogService } from "../sdk/logger.js";
import {
  createMatrixJsSdkClientLogger,
  ensureMatrixSdkLoggingConfigured,
  setMatrixSdkConsoleLogging,
  setMatrixSdkLogMode,
} from "./logging.js";

describe("Matrix SDK logging", () => {
  afterEach(() => {
    setMatrixSdkLogMode("default");
    setMatrixSdkConsoleLogging(false);
    vi.restoreAllMocks();
    delete process.env.MATRIX_SDK_DEBUG;
    delete process.env.OPENCLAW_MATRIX_SDK_DEBUG;
  });

  it("suppresses Matrix SDK client logs in quiet mode", () => {
    setMatrixSdkConsoleLogging(true);
    setMatrixSdkLogMode("quiet");
    ensureMatrixSdkLoggingConfigured();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    createMatrixJsSdkClientLogger("MatrixClient").info("should be quiet");
    matrixJsSdkLogger.info("global logger should be quiet");
    LogService.info("MatrixClient", "should also be quiet");

    expect(info).not.toHaveBeenCalled();
  });

  it("does not force Matrix JS SDK debug logs by default", () => {
    const loglevelLogger = matrixJsSdkLogger as unknown as {
      levels: { INFO: number };
      setLevel: (level: number | string, persist?: boolean) => void;
    };
    const setLevel = vi.spyOn(loglevelLogger, "setLevel").mockImplementation(() => undefined);

    ensureMatrixSdkLoggingConfigured();

    expect(setLevel).toHaveBeenLastCalledWith(loglevelLogger.levels.INFO, false);
  });
});
