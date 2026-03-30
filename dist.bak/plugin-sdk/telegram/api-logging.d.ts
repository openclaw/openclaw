import type { RuntimeEnv } from "../runtime.js";
export type TelegramApiLogger = (message: string) => void;
type TelegramApiLoggingParams<T> = {
    operation: string;
    fn: () => Promise<T>;
    runtime?: RuntimeEnv;
    logger?: TelegramApiLogger;
    shouldLog?: (err: unknown) => boolean;
};
export declare function withTelegramApiErrorLogging<T>({ operation, fn, runtime, logger, shouldLog, }: TelegramApiLoggingParams<T>): Promise<T>;
export {};
