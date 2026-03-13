import { type RuntimeEnv } from "../runtime.js";
import { type LogLevel } from "./levels.js";
export type SubsystemLogger = {
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
export declare function stripRedundantSubsystemPrefixForConsole(message: string, displaySubsystem: string): string;
export declare function createSubsystemLogger(subsystem: string): SubsystemLogger;
export declare function runtimeForLogger(logger: SubsystemLogger, exit?: RuntimeEnv["exit"]): RuntimeEnv;
export declare function createSubsystemRuntime(subsystem: string, exit?: RuntimeEnv["exit"]): RuntimeEnv;
