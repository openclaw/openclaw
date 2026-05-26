import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { Fr as ZodIssue, mt as ZodType, zr as $RefinementCtx } from "./schemas-CkRCGSfd.js";
import { t as createLoggerBackedRuntime } from "./runtime-logger-BjGNJFh2.js";

//#region src/utils/zod-parse.d.ts
declare function safeParseWithSchema<T>(schema: ZodType<T>, value: unknown): T | null;
declare function safeParseJsonWithSchema<T>(schema: ZodType<T>, raw: string): T | null;
//#endregion
//#region src/plugin-sdk/extension-shared.d.ts
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
  ctx: $RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => void;
declare function buildPassiveChannelStatusSummary<TExtra extends object>(snapshot: PassiveChannelStatusSnapshot, extra?: TExtra): {
  configured: boolean;
} & TExtra & {
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
};
declare function buildPassiveProbedChannelStatusSummary<TExtra extends object>(snapshot: PassiveChannelStatusSnapshot, extra?: TExtra): {
  configured: boolean;
} & TExtra & {
  probe: unknown;
  lastProbeAt: number | null;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
};
declare function buildTrafficStatusSummary(snapshot?: TrafficStatusSnapshot | null): {
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
};
declare function runStoppablePassiveMonitor<TMonitor extends StoppableMonitor>(params: {
  abortSignal: AbortSignal;
  start: () => Promise<TMonitor>;
}): Promise<void>;
declare function resolveLoggerBackedRuntime<TRuntime>(runtime: TRuntime | undefined, logger: Parameters<typeof createLoggerBackedRuntime>[0]["logger"]): TRuntime;
declare function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: $RefinementCtx;
  requireOpenAllowFrom: RequireOpenAllowFromFn;
}): void;
declare function readStatusIssueFields<TField extends string>(value: unknown, fields: readonly TField[]): Record<TField, unknown> | null;
declare function coerceStatusIssueAccountId(value: unknown): string | undefined;
declare function createDeferred<T>(): {
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
declare function formatPluginConfigIssue(issue: ZodIssue | undefined, options?: PluginConfigIssueMessageOptions): string;
declare function normalizePluginConfigIssuePath(path: readonly unknown[]): PluginConfigIssuePathSegment[];
declare function mapPluginConfigIssues(issues: readonly ZodIssue[], options?: PluginConfigIssueMessageOptions): PluginConfigIssue[];
declare function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg?: OpenClawConfig;
  provider: string;
  id: string;
}): boolean;
declare function readPluginPackageVersion(params: {
  require: PackageJsonRequire;
  candidates?: readonly string[];
  fallback?: string;
}): string;
declare function resolveAmbientNodeProxyAgent<TAgent>(params?: {
  onError?: (error: unknown) => void;
  onUsingProxy?: () => void;
  protocol?: "http" | "https";
}): Promise<TAgent | undefined>;
//#endregion
export { safeParseWithSchema as _, coerceStatusIssueAccountId as a, mapPluginConfigIssues as c, readStatusIssueFields as d, requireChannelOpenAllowFrom as f, safeParseJsonWithSchema as g, runStoppablePassiveMonitor as h, canResolveEnvSecretRefInReadOnlyPath as i, normalizePluginConfigIssuePath as l, resolveLoggerBackedRuntime as m, buildPassiveProbedChannelStatusSummary as n, createDeferred as o, resolveAmbientNodeProxyAgent as p, buildTrafficStatusSummary as r, formatPluginConfigIssue as s, buildPassiveChannelStatusSummary as t, readPluginPackageVersion as u };