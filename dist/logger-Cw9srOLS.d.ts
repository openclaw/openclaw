import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as LogLevel } from "./levels-D4DyRhwH.js";
import { Logger } from "tslog";

//#region src/logging/types.d.ts
type ConsoleStyle = "pretty" | "compact" | "json";
type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  maxFileBytes?: number;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
};
//#endregion
//#region src/logging/config.d.ts
declare function shouldSkipMutatingLoggingConfigRead(argv?: string[]): boolean;
//#endregion
//#region src/logging/logger.d.ts
declare const DEFAULT_LOG_DIR: string;
declare const DEFAULT_LOG_FILE: string;
type LogObj = {
  date?: Date;
} & Record<string, unknown>;
type ResolvedSettings = {
  level: LogLevel;
  file: string;
  maxFileBytes: number;
};
type LoggerResolvedSettings = ResolvedSettings;
type LoggerConfigLoader = () => OpenClawConfig["logging"] | undefined;
declare function setLoggerConfigLoaderForTests(loader?: LoggerConfigLoader): void;
declare function isFileLogLevelEnabled(level: LogLevel): boolean;
declare function getLogger(): Logger<LogObj>;
declare function getChildLogger(bindings?: Record<string, unknown>, opts?: {
  level?: LogLevel;
}): Logger<LogObj>;
declare function toPinoLikeLogger(logger: Logger<LogObj>, level: LogLevel): PinoLikeLogger;
type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};
declare function getResolvedLoggerSettings(): LoggerResolvedSettings;
declare function setLoggerOverride(settings: LoggerSettings | null): void;
declare function resetLogger(): void;
declare const __test__: {
  resolveActiveLogFile: typeof resolveActiveLogFile;
  shouldSkipMutatingLoggingConfigRead: typeof shouldSkipMutatingLoggingConfigRead;
};
declare function resolveActiveLogFile(file: string): string;
//#endregion
export { __test__ as a, getResolvedLoggerSettings as c, setLoggerConfigLoaderForTests as d, setLoggerOverride as f, LoggerSettings as h, PinoLikeLogger as i, isFileLogLevelEnabled as l, ConsoleStyle as m, DEFAULT_LOG_FILE as n, getChildLogger as o, toPinoLikeLogger as p, LoggerResolvedSettings as r, getLogger as s, DEFAULT_LOG_DIR as t, resetLogger as u };