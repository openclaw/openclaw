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

const capture = (method: "debug" | "info" | "warn" | "error" | "trace") =>
  vi.spyOn(console, method).mockImplementation(() => {});

describe("Matrix SDK logging", () => {
  it("applies quiet mode at configuration and restores the SDK logger level afterward", () => {
    const logger = matrixJsSdkRootLogger as MatrixJsSdkTestLogger;
    const originalLevel = logger.getLevel?.();
    const originalMethodFactory = logger.methodFactory;
    const warn = capture("warn"),
      error = capture("error"),
      info = capture("info"),
      trace = capture("trace");
    const clientLogger = createMatrixJsSdkClientLogger("MatrixHttpClient").getChild("requests");
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
      const cancellation = ["[MatrixHttpClient.requests] Cancelling verification request"];
      expect(info.mock.calls).toEqual([cancellation]);
      clientLogger.error({ errcode: "M_NOT_FOUND" });
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
        cancellation,
        ...Array.from({ length: 2 }, () => ["root sync started", { phase: "sync" }]),
      ]);
      expect(trace.mock.calls).toEqual(
        Array.from({ length: 4 }, () => ["membership event with membership undefined"]),
      );
      expect(warn.mock.calls.slice(3)).toEqual(
        Array.from({ length: 2 }, () => ["root sync warning", { phase: "sync" }]),
      );
    } finally {
      if (typeof originalLevel === "string" || typeof originalLevel === "number") {
        logger.setLevel?.(originalLevel, false);
      }
      logger.methodFactory = originalMethodFactory;
      logger.rebuild?.();
      setMatrixSdkLogMode("default");
      setMatrixConsoleLogging(false);
      for (const spy of [warn, error, info, trace]) {
        spy.mockRestore();
      }
    }
  });

  it("quiets and restores real SDK children created before and during quiet mode", () => {
    const debug = capture("debug"),
      info = capture("info"),
      warn = capture("warn"),
      error = capture("error");
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
      const labels = ["[before quiet]", "[during quiet]", "[before quiet][nested quiet]"];
      const expectOutput = (spy: typeof debug, mode: "quiet" | "default", ...args: unknown[]) => {
        expect(spy.mock.calls).toEqual(
          mode === "quiet" ? [] : labels.map((label) => Array.of<unknown>(label).concat(args)),
        );
        spy.mockClear();
      };

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
          expectOutput(spy, mode, message);
        }
        expectOutput(debug, mode, "diagnostic", { phase: "sync" });
      }
    } finally {
      setMatrixSdkLogMode("default");
      for (const spy of [debug, info, warn, error]) {
        spy.mockRestore();
      }
    }
  });
});
