import type { RuntimeEnv } from "../runtime.js";
export type LingerPrompter = {
    confirm?: (params: {
        message: string;
        initialValue?: boolean;
    }) => Promise<boolean>;
    note: (message: string, title?: string) => Promise<void> | void;
};
export declare function ensureSystemdUserLingerInteractive(params: {
    runtime: RuntimeEnv;
    prompter?: LingerPrompter;
    env?: NodeJS.ProcessEnv;
    title?: string;
    reason?: string;
    prompt?: boolean;
    requireConfirm?: boolean;
}): Promise<void>;
export declare function ensureSystemdUserLingerNonInteractive(params: {
    runtime: RuntimeEnv;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
