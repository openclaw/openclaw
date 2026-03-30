import type { Command } from "commander";
import { formatErrorMessage } from "../infra/errors.js";
export { formatErrorMessage };
export type ManagerLookupResult<T> = {
    manager: T | null;
    error?: string;
};
export declare function withManager<T>(params: {
    getManager: () => Promise<ManagerLookupResult<T>>;
    onMissing: (error?: string) => void;
    run: (manager: T) => Promise<void>;
    close: (manager: T) => Promise<void>;
    onCloseError?: (err: unknown) => void;
}): Promise<void>;
export declare function runCommandWithRuntime(runtime: {
    error: (message: string) => void;
    exit: (code: number) => void;
}, action: () => Promise<void>, onError?: (error: unknown) => void): Promise<void>;
export declare function resolveOptionFromCommand<T>(command: Command | undefined, key: string): T | undefined;
