import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveControlUiLinks } from "../gateway/control-ui-links.js";
import { detectBrowserOpenSupport, openUrl, resolveBrowserOpenCommand } from "../infra/browser-open.js";
import { detectBinary } from "../infra/detect-binary.js";
import type { RuntimeEnv } from "../runtime.js";
import type { NodeManagerChoice, OnboardMode, ResetScope } from "./onboard-types.js";
export { randomToken } from "./random-token.js";
export { detectBinary };
export { detectBrowserOpenSupport, openUrl, resolveBrowserOpenCommand };
export { resolveControlUiLinks };
export declare function guardCancel<T>(value: T | symbol, runtime: RuntimeEnv): T;
export declare function summarizeExistingConfig(config: OpenClawConfig): string;
export declare function normalizeGatewayTokenInput(value: unknown): string;
export declare function validateGatewayPasswordInput(value: unknown): string | undefined;
export declare function printWizardHeader(runtime: RuntimeEnv): void;
export declare function applyWizardMetadata(cfg: OpenClawConfig, params: {
    command: string;
    mode: OnboardMode;
}): OpenClawConfig;
export declare function formatControlUiSshHint(params: {
    port: number;
    basePath?: string;
    token?: string;
}): string;
export declare function ensureWorkspaceAndSessions(workspaceDir: string, runtime: RuntimeEnv, options?: {
    skipBootstrap?: boolean;
    skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
    agentId?: string;
}): Promise<void>;
export declare function resolveNodeManagerOptions(): Array<{
    value: NodeManagerChoice;
    label: string;
}>;
export declare function moveToTrash(pathname: string, runtime: RuntimeEnv): Promise<void>;
export declare function handleReset(scope: ResetScope, workspaceDir: string, runtime: RuntimeEnv): Promise<void>;
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
