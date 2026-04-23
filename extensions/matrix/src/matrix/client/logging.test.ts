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
});
