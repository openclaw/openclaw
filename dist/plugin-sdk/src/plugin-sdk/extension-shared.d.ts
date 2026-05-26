import type { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { createLoggerBackedRuntime } from "./runtime-logger.js";
export { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
export { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
type PassiveChannelStatusSnapshot = {
    configured?: boolean;
    running?: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
};
type TrafficStatusSnapshot = {
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
};
type StoppableMonitor = {
    stop: () => void;
};
type RequireOpenAllowFromFn = (params: {
    policy?: string;
    allowFrom?: Array<string | number>;
    ctx: z.RefinementCtx;
    path: Array<string | number>;
    message: string;
}) => void;
export declare function buildPassiveChannelStatusSummary<TExtra extends object>(snapshot: PassiveChannelStatusSnapshot, extra?: TExtra): {
    configured: boolean;
} & TExtra & {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
};
export declare function buildPassiveProbedChannelStatusSummary<TExtra extends object>(snapshot: PassiveChannelStatusSnapshot, extra?: TExtra): {
    configured: boolean;
} & TExtra & {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    lastProbeAt: number | null;
};
export declare function buildTrafficStatusSummary(snapshot?: TrafficStatusSnapshot | null): {
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
};
export declare function runStoppablePassiveMonitor<TMonitor extends StoppableMonitor>(params: {
    abortSignal: AbortSignal;
    start: () => Promise<TMonitor>;
}): Promise<void>;
export declare function resolveLoggerBackedRuntime<TRuntime>(runtime: TRuntime | undefined, logger: Parameters<typeof createLoggerBackedRuntime>[0]["logger"]): TRuntime;
export declare function requireChannelOpenAllowFrom(params: {
    channel: string;
    policy?: string;
    allowFrom?: Array<string | number>;
    ctx: z.RefinementCtx;
    requireOpenAllowFrom: RequireOpenAllowFromFn;
}): void;
export declare function readStatusIssueFields<TField extends string>(value: unknown, fields: readonly TField[]): Record<TField, unknown> | null;
export declare function coerceStatusIssueAccountId(value: unknown): string | undefined;
export declare function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};
type PackageJsonRequire = (id: string) => unknown;
type PluginConfigIssuePathSegment = string | number;
type PluginConfigIssue = {
    path: PluginConfigIssuePathSegment[];
    message: string;
};
type PluginConfigIssueMessageOptions = {
    invalidConfigMessage?: string;
    unknownKeyMessage?: (key: string) => string;
    rootInvalidTypeMessage?: string;
};
export declare function formatPluginConfigIssue(issue: z.ZodIssue | undefined, options?: PluginConfigIssueMessageOptions): string;
export declare function normalizePluginConfigIssuePath(path: readonly unknown[]): PluginConfigIssuePathSegment[];
export declare function mapPluginConfigIssues(issues: readonly z.ZodIssue[], options?: PluginConfigIssueMessageOptions): PluginConfigIssue[];
export declare function canResolveEnvSecretRefInReadOnlyPath(params: {
    cfg?: OpenClawConfig;
    provider: string;
    id: string;
}): boolean;
export declare function readPluginPackageVersion(params: {
    require: PackageJsonRequire;
    candidates?: readonly string[];
    fallback?: string;
}): string;
export declare function resolveAmbientNodeProxyAgent<TAgent>(params?: {
    onError?: (error: unknown) => void;
    onUsingProxy?: () => void;
    protocol?: "http" | "https";
}): Promise<TAgent | undefined>;
