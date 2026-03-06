import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { NodeManagerChoice, OnboardMode, ResetScope } from "./onboard-types.js";
export declare function guardCancel<T>(value: T | symbol, runtime: RuntimeEnv): T;
export declare function summarizeExistingConfig(config: OpenClawConfig): string;
export declare function randomToken(): string;
export declare function normalizeGatewayTokenInput(value: unknown): string;
export declare function validateGatewayPasswordInput(value: unknown): string | undefined;
export declare function printWizardHeader(runtime: RuntimeEnv): void;
export declare function applyWizardMetadata(cfg: OpenClawConfig, params: {
    command: string;
    mode: OnboardMode;
}): OpenClawConfig;
type BrowserOpenSupport = {
    ok: boolean;
    reason?: string;
    command?: string;
};
type BrowserOpenCommand = {
    argv: string[] | null;
    reason?: string;
    command?: string;
    /**
     * Whether the URL must be wrapped in quotes when appended to argv.
     * Needed for Windows `cmd /c start` where `&` splits commands.
     */
    quoteUrl?: boolean;
};
export declare function resolveBrowserOpenCommand(): Promise<BrowserOpenCommand>;
export declare function detectBrowserOpenSupport(): Promise<BrowserOpenSupport>;
export declare function formatControlUiSshHint(params: {
    port: number;
    basePath?: string;
    token?: string;
}): string;
export declare function openUrl(url: string): Promise<boolean>;
export declare function openUrlInBackground(url: string): Promise<boolean>;
export declare function ensureWorkspaceAndSessions(workspaceDir: string, runtime: RuntimeEnv, options?: {
    skipBootstrap?: boolean;
    agentId?: string;
}): Promise<void>;
export declare function resolveNodeManagerOptions(): Array<{
    value: NodeManagerChoice;
    label: string;
}>;
export declare function moveToTrash(pathname: string, runtime: RuntimeEnv): Promise<void>;
export declare function handleReset(scope: ResetScope, workspaceDir: string, runtime: RuntimeEnv): Promise<void>;
export declare function detectBinary(name: string): Promise<boolean>;
export declare function probeGatewayReachable(params: {
    url: string;
    token?: string;
    password?: string;
    timeoutMs?: number;
}): Promise<{
    ok: boolean;
    detail?: string;
}>;
export declare function waitForGatewayReachable(params: {
    url: string;
    token?: string;
    password?: string;
    /** Total time to wait before giving up. */
    deadlineMs?: number;
    /** Per-probe timeout (each probe makes a full gateway health request). */
    probeTimeoutMs?: number;
    /** Delay between probes. */
    pollMs?: number;
}): Promise<{
    ok: boolean;
    detail?: string;
}>;
export declare const DEFAULT_WORKSPACE: string;
export declare function resolveControlUiLinks(params: {
    port: number;
    bind?: "auto" | "lan" | "loopback" | "custom" | "tailnet";
    customBindHost?: string;
    basePath?: string;
}): {
    httpUrl: string;
    wsUrl: string;
};
export {};
