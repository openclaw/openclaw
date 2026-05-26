import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as LogLevel } from "./levels-561AeL30.js";
import { m as ConsoleStyle } from "./logger-CnFTzVot.js";

//#region src/logging/console.d.ts
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
type ConsoleLoggerSettings = ConsoleSettings;
type ConsoleConfigLoader = () => OpenClawConfig["logging"] | undefined;
declare function setConsoleConfigLoaderForTests(loader?: ConsoleConfigLoader): void;
declare function getConsoleSettings(): ConsoleLoggerSettings;
declare function getResolvedConsoleSettings(): ConsoleLoggerSettings;
declare function routeLogsToStderr(): void;
declare function setConsoleSubsystemFilter(filters?: string[] | null): void;
declare function setConsoleTimestampPrefix(enabled: boolean): void;
declare function shouldLogSubsystemToConsole(subsystem?: string | null): boolean;
/**
 * Route console.* calls through file logging while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
declare function enableConsoleCapture(): void;
//#endregion
//#region src/infra/abort-signal.d.ts
declare function waitForAbortSignal(signal?: AbortSignal): Promise<void>;
//#endregion
//#region src/infra/unhandled-rejections.d.ts
type UnhandledRejectionHandler = (reason: unknown) => boolean;
type UncaughtExceptionHandler = (error: unknown) => boolean;
/**
 * Checks if an error is an AbortError.
 * These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
 */
declare function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void;
declare function registerUncaughtExceptionHandler(handler: UncaughtExceptionHandler): () => void;
//#endregion
export { enableConsoleCapture as a, routeLogsToStderr as c, setConsoleTimestampPrefix as d, shouldLogSubsystemToConsole as f, ConsoleLoggerSettings as i, setConsoleConfigLoaderForTests as l, registerUnhandledRejectionHandler as n, getConsoleSettings as o, waitForAbortSignal as r, getResolvedConsoleSettings as s, registerUncaughtExceptionHandler as t, setConsoleSubsystemFilter as u };