import { n as RuntimeEnv, t as OutputRuntimeEnv } from "./runtime-Bxifh4bY.js";
import { n as LogLevel } from "./levels-561AeL30.js";

//#region src/logging/subsystem.d.ts
type SubsystemLogger = {
  subsystem: string;
  isEnabled: (level: LogLevel, target?: "any" | "console" | "file") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => SubsystemLogger;
};
declare function stripRedundantSubsystemPrefixForConsole(message: string, displaySubsystem: string): string;
declare function createSubsystemLogger(subsystem: string): SubsystemLogger;
declare function runtimeForLogger(logger: SubsystemLogger, exit?: RuntimeEnv["exit"]): OutputRuntimeEnv;
declare function createSubsystemRuntime(subsystem: string, exit?: RuntimeEnv["exit"]): OutputRuntimeEnv;
//#endregion
export { stripRedundantSubsystemPrefixForConsole as a, runtimeForLogger as i, createSubsystemLogger as n, createSubsystemRuntime as r, SubsystemLogger as t };