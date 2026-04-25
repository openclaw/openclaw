import { logger as matrixJsSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import { describe, expect, it, vi } from "vitest";
import { ensureMatrixSdkLoggingConfigured, setMatrixSdkLogMode } from "./logging.js";

describe("Matrix SDK logging", () => {
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
