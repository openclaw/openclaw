import { Logger as TsLogger } from "tslog";
import type { ConsoleStyle } from "./console.js";
import { type LogLevel } from "./levels.js";
export declare const DEFAULT_LOG_DIR: string;
export declare const DEFAULT_LOG_FILE: string;
export type LoggerSettings = {
    level?: LogLevel;
    file?: string;
    maxFileBytes?: number;
    consoleLevel?: LogLevel;
    consoleStyle?: ConsoleStyle;
};
type LogObj = {
    date?: Date;
} & Record<string, unknown>;
type ResolvedSettings = {
    level: LogLevel;
    file: string;
    maxFileBytes: number;
};
export type LoggerResolvedSettings = ResolvedSettings;
export type LogTransportRecord = Record<string, unknown>;
export type LogTransport = (logObj: LogTransportRecord) => void;
export declare function isFileLogLevelEnabled(level: LogLevel): boolean;
export declare function getLogger(): TsLogger<LogObj>;
export declare function getChildLogger(bindings?: Record<string, unknown>, opts?: {
    level?: LogLevel;
}): TsLogger<LogObj>;
export declare function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger;
export type PinoLikeLogger = {
    level: string;
    child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    fatal: (...args: unknown[]) => void;
};
export declare function getResolvedLoggerSettings(): LoggerResolvedSettings;
export declare function setLoggerOverride(settings: LoggerSettings | null): void;
export declare function resetLogger(): void;
export declare function registerLogTransport(transport: LogTransport): () => void;
export {};
