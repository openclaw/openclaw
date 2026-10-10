// Matrix tests cover logging plugin behavior.
import { logger as matrixJsSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import { describe, expect, it, vi } from "vitest";
import { LogService, setMatrixConsoleLogging } from "../sdk/logger.js";
import {
  createMatrixJsSdkClientLogger,
  ensureMatrixSdkLoggingConfigured,
  setMatrixSdkLogMode,
} from "./logging.js";

type MatrixJsSdkTestLogger = typeof matrixJsSdkRootLogger & {
  getLevel?: () => number | string;
  levels: { WARN: number };
  methodFactory?: unknown;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

describe("Matrix SDK logging", () => {
  it("applies quiet mode at configuration and restores the SDK logger level afterward", () => {
    const logger = matrixJsSdkRootLogger as MatrixJsSdkTestLogger;
    const originalLevel = logger.getLevel?.();
    const originalMethodFactory = logger.methodFactory;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const clientLogger = createMatrixJsSdkClientLogger("MatrixHttpClient").getChild("requests");
    const missing = { errcode: "M_NOT_FOUND" };
    try {
      setMatrixConsoleLogging(true);
      logger.setLevel?.("warn", false);
      setMatrixSdkLogMode("quiet");
      LogService.warn("MatrixClient", "before configuration");
      clientLogger.warn("quiet client");
      expect(warn.mock.calls).toEqual([["[MatrixClient] before configuration"]]);

      ensureMatrixSdkLoggingConfigured();
      LogService.warn("MatrixClient", "quiet service");
      clientLogger.warn("quiet client");
      expect(warn).toHaveBeenCalledTimes(1);
      setMatrixSdkLogMode("default");

      expect(logger.getLevel?.()).toBe(logger.levels.WARN);
      expect(logger.methodFactory).toBe(originalMethodFactory);
      LogService.warn("MatrixClient", "restored %s", "service");
      clientLogger.warn("restored %s", "client");
      expect(warn.mock.calls.slice(1)).toEqual([
        ["[MatrixClient] restored service"],
        ["[MatrixHttpClient.requests] restored client"],
      ]);
      clientLogger.error(missing);
      clientLogger.error("real error");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[MatrixHttpClient.requests] real error");
    } finally {
      if (typeof originalLevel === "string" || typeof originalLevel === "number") {
        logger.setLevel?.(originalLevel, false);
      }
      logger.methodFactory = originalMethodFactory;
      logger.rebuild?.();
      setMatrixSdkLogMode("default");
      setMatrixConsoleLogging(false);
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("quiets the Matrix JS SDK global logger for JSON-safe CLI commands", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      ensureMatrixSdkLoggingConfigured();
      setMatrixSdkLogMode("quiet");

      matrixJsSdkRootLogger.getChild("[MatrixRTCSession test]").debug("noisy diagnostic");

      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      setMatrixSdkLogMode("default");
      debugSpy.mockRestore();
    }
  });
});
