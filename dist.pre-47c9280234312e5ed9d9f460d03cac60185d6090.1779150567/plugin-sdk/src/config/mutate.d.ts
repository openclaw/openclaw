import { readConfigFileSnapshotForWrite, type ConfigWriteOptions, type ConfigWriteResult } from "./io.js";
import { type ConfigWriteAfterWrite, type ConfigWriteFollowUp } from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
export type ConfigMutationBase = "runtime" | "source";
export declare class ConfigMutationConflictError extends Error {
    readonly currentHash: string | null;
    constructor(message: string, params: {
        currentHash: string | null;
    });
}
export type ConfigReplaceResult = {
    path: string;
    previousHash: string | null;
    snapshot: ConfigFileSnapshot;
    nextConfig: OpenClawConfig;
    persistedHash: string | null;
    afterWrite: ConfigWriteAfterWrite;
    followUp: ConfigWriteFollowUp;
};
export type ConfigMutationIO = {
    readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
    writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<ConfigWriteResult | void>;
};
export type ConfigMutationContext = {
    snapshot: ConfigFileSnapshot;
    previousHash: string | null;
    attempt: number;
};
export type ConfigTransformResult<T> = {
    nextConfig: OpenClawConfig;
    result?: T;
};
export type ConfigMutationCommitParams = {
    nextConfig: OpenClawConfig;
    snapshot: ConfigFileSnapshot;
    baseHash?: string;
    writeOptions?: ConfigWriteOptions;
    afterWrite: ConfigWriteAfterWrite;
    io?: ConfigMutationIO;
};
export type ConfigMutationCommitResult = {
    config: OpenClawConfig;
    persistedHash: string | null;
    afterWrite?: ConfigWriteAfterWrite;
};
export type ConfigMutationCommit = (params: ConfigMutationCommitParams) => Promise<ConfigMutationCommitResult>;
export type TransformConfigFileParams<T> = {
    base?: ConfigMutationBase;
    baseHash?: string;
    afterWrite?: ConfigWriteOptions["afterWrite"];
    writeOptions?: ConfigWriteOptions;
    io?: ConfigMutationIO;
    commit?: ConfigMutationCommit;
    transform: (currentConfig: OpenClawConfig, context: ConfigMutationContext) => Promise<ConfigTransformResult<T>> | ConfigTransformResult<T>;
};
export type TransformConfigFileWithRetryParams<T> = TransformConfigFileParams<T> & {
    maxAttempts?: number;
};
export type ConfigMutationResult<T> = ConfigReplaceResult & {
    result: T | undefined;
    attempts: number;
};
export declare function replaceConfigFile(params: {
    nextConfig: OpenClawConfig;
    baseHash?: string;
    snapshot?: ConfigFileSnapshot;
    afterWrite?: ConfigWriteOptions["afterWrite"];
    writeOptions?: ConfigWriteOptions;
    io?: ConfigMutationIO;
}): Promise<ConfigReplaceResult>;
export declare function transformConfigFile<T = void>(params: TransformConfigFileParams<T>): Promise<ConfigMutationResult<T>>;
export declare function transformConfigFileWithRetry<T = void>(params: TransformConfigFileWithRetryParams<T>): Promise<ConfigMutationResult<T>>;
export declare function mutateConfigFile<T = void>(params: {
    base?: ConfigMutationBase;
    baseHash?: string;
    afterWrite?: ConfigWriteOptions["afterWrite"];
    writeOptions?: ConfigWriteOptions;
    io?: ConfigMutationIO;
    mutate: (draft: OpenClawConfig, context: ConfigMutationContext) => Promise<T | void> | T | void;
}): Promise<ConfigMutationResult<T>>;
export declare function mutateConfigFileWithRetry<T = void>(params: {
    base?: ConfigMutationBase;
    baseHash?: string;
    maxAttempts?: number;
    afterWrite?: ConfigWriteOptions["afterWrite"];
    writeOptions?: ConfigWriteOptions;
    io?: ConfigMutationIO;
    mutate: (draft: OpenClawConfig, context: ConfigMutationContext) => Promise<T | void> | T | void;
}): Promise<ConfigMutationResult<T>>;
