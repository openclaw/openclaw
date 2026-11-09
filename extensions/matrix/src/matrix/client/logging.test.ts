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
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = vi.spyOn(console, "trace").mockImplementation(() => {});
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
      LogService.warn("MatrixClient", "restored %s", "service");
      clientLogger.warn("restored %s", "client");
      expect(warn.mock.calls.slice(1)).toEqual([
        ["[MatrixClient] restored service"],
        ["[MatrixHttpClient.requests] restored client"],
      ]);
      clientLogger.info("Cancelling verification request with params:", {
        reason: "synthetic-private-tool-reason",
        code: "synthetic-private-tool-code",
      });
      expect(info.mock.calls).toEqual([
        ["[MatrixHttpClient.requests] Cancelling verification request"],
      ]);
      clientLogger.error(missing);
      clientLogger.error("real error");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[MatrixHttpClient.requests] real error");

      for (const quiet of [false, true, false]) {
        setMatrixSdkLogMode(quiet ? "quiet" : "default");
        ensureMatrixSdkLoggingConfigured();
        if (!quiet) {
          expect(logger.getLevel?.()).toBe(logger.levels.WARN);
          logger.setLevel?.("trace", false);
        }
        logger.info("root sync started", { phase: "sync" });
        logger.info("Storing user profile @synthetic-private-user:example.test", {
          profile_updates: { displayname: "synthetic-private-profile" },
        });
        for (const forwardLooking of [true, false]) {
          logger.trace(
            `membership event with membership undefined (forwardLooking: ${forwardLooking})!`,
            { displayname: "synthetic-current-membership" },
            "prevcontent is ",
            { displayname: "synthetic-previous-membership" },
          );
        }
        logger.warn("root sync warning", { phase: "sync" });
      }
      expect(info.mock.calls).toEqual([
        ["[MatrixHttpClient.requests] Cancelling verification request"],
        ["root sync started", { phase: "sync" }],
        ["root sync started", { phase: "sync" }],
      ]);
      expect(trace.mock.calls).toEqual([
        ["membership event with membership undefined"],
        ["membership event with membership undefined"],
        ["membership event with membership undefined"],
        ["membership event with membership undefined"],
      ]);
      expect(warn.mock.calls.slice(3)).toEqual([
        ["root sync warning", { phase: "sync" }],
        ["root sync warning", { phase: "sync" }],
      ]);
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
      info.mockRestore();
      trace.mockRestore();
    }
  });

  it("quiets and restores real SDK children created before and during quiet mode", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ensureMatrixSdkLoggingConfigured();
      const beforeQuiet = matrixJsSdkRootLogger.getChild("[before quiet]");
      beforeQuiet.debug("normal diagnostic", { phase: "sync" });
      expect(debug.mock.calls).toEqual([
        ["[before quiet]", "normal diagnostic", { phase: "sync" }],
      ]);
      debug.mockClear();
      setMatrixSdkLogMode("quiet");
      const duringQuiet = matrixJsSdkRootLogger.getChild("[during quiet]");
      const nestedDuringQuiet = beforeQuiet.getChild("[nested quiet]");
      const children = [beforeQuiet, duringQuiet, nestedDuringQuiet];

      for (const mode of ["quiet", "default", "quiet", "default"] as const) {
        setMatrixSdkLogMode(mode);
        for (const child of children) {
          child.debug("diagnostic", { phase: "sync" });
          child.info("lifecycle");
          child.warn("warning");
          child.error("failure");
        }
        for (const [spy, message] of [
          [info, "lifecycle"],
          [warn, "warning"],
          [error, "failure"],
        ] as const) {
          expect(spy.mock.calls).toEqual(
            mode === "quiet"
              ? []
              : [
                  ["[before quiet]", message],
                  ["[during quiet]", message],
                  ["[before quiet][nested quiet]", message],
                ],
          );
          spy.mockClear();
        }
        expect(debug.mock.calls).toEqual(
          mode === "quiet"
            ? []
            : [
                ["[before quiet]", "diagnostic", { phase: "sync" }],
                ["[during quiet]", "diagnostic", { phase: "sync" }],
                ["[before quiet][nested quiet]", "diagnostic", { phase: "sync" }],
              ],
        );
        debug.mockClear();
      }
    } finally {
      setMatrixSdkLogMode("default");
      debug.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
