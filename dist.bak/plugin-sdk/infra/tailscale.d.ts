import { promptYesNo } from "../cli/prompt.js";
import { runExec } from "../process/exec.js";
import { type RuntimeEnv } from "../runtime.js";
/**
 * Locate Tailscale binary using multiple strategies:
 * 1. PATH lookup (via which command)
 * 2. Known macOS app path
 * 3. find /Applications for Tailscale.app
 * 4. locate database (if available)
 *
 * @returns Path to Tailscale binary or null if not found
 */
export declare function findTailscaleBinary(): Promise<string | null>;
export declare function getTailnetHostname(exec?: typeof runExec, detectedBinary?: string): Promise<string>;
export declare function getTailscaleBinary(): Promise<string>;
export declare function readTailscaleStatusJson(exec?: typeof runExec, opts?: {
    timeoutMs?: number;
}): Promise<Record<string, unknown>>;
export declare function ensureGoInstalled(exec?: typeof runExec, prompt?: typeof promptYesNo, runtime?: RuntimeEnv): Promise<void>;
export declare function ensureTailscaledInstalled(exec?: typeof runExec, prompt?: typeof promptYesNo, runtime?: RuntimeEnv): Promise<void>;
export type TailscaleWhoisIdentity = {
    login: string;
    name?: string;
};
export declare function ensureFunnel(port: number, exec?: typeof runExec, runtime?: RuntimeEnv, prompt?: typeof promptYesNo): Promise<void>;
export declare function enableTailscaleServe(port: number, exec?: typeof runExec): Promise<void>;
export declare function disableTailscaleServe(exec?: typeof runExec): Promise<void>;
export declare function enableTailscaleFunnel(port: number, exec?: typeof runExec): Promise<void>;
export declare function disableTailscaleFunnel(exec?: typeof runExec): Promise<void>;
export declare function readTailscaleWhoisIdentity(ip: string, exec?: typeof runExec, opts?: {
    timeoutMs?: number;
    cacheTtlMs?: number;
    errorTtlMs?: number;
}): Promise<TailscaleWhoisIdentity | null>;
