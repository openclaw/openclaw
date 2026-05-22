import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExecHost, type ExecApprovalDecision, type ExecTarget } from "../infra/exec-approvals.js";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
export { applyPathPrepend, findPathKey, normalizePathPrepend } from "../infra/path-prepend.js";
export { normalizeExecAsk, normalizeExecHost, normalizeExecSecurity, normalizeExecTarget, } from "../infra/exec-approvals.js";
import type { RunExit } from "../process/supervisor/types.js";
import { type DeliveryContext } from "../utils/delivery-context.shared.js";
export { execSchema } from "./bash-tools.schemas.js";
/**
 * Detect cursor key mode from PTY output chunk.
 * Uses lastIndexOf to find the *last* toggle in the chunk.
 * Returns "application" if smkx is the last toggle, "normal" if rmkx is last,
 * or null if no toggle is found.
 */
export declare function detectCursorKeyMode(raw: string): "application" | "normal" | null;
export declare function sanitizeHostBaseEnv(env: Record<string, string>): Record<string, string>;
export declare function validateHostEnv(env: Record<string, string>): void;
export declare const DEFAULT_MAX_OUTPUT: number;
export declare const DEFAULT_PENDING_MAX_OUTPUT: number;
export declare const DEFAULT_PATH: string;
export declare const DEFAULT_NOTIFY_TAIL_CHARS = 400;
export declare const DEFAULT_APPROVAL_TIMEOUT_MS = 1800000;
export declare const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS: number;
export type ExecProcessFailureKind = "shell-command-not-found" | "shell-not-executable" | "overall-timeout" | "no-output-timeout" | "signal" | "aborted" | "runtime-error";
type ExecExitFailureKind = Exclude<ExecProcessFailureKind, "runtime-error">;
export type ExecProcessOutcome = {
    status: "completed";
    exitCode: number;
    exitSignal: NodeJS.Signals | number | null;
    durationMs: number;
    aggregated: string;
    timedOut: false;
} | {
    status: "failed";
    exitCode: number | null;
    exitSignal: NodeJS.Signals | number | null;
    durationMs: number;
    aggregated: string;
    timedOut: boolean;
    failureKind: ExecProcessFailureKind;
    reason: string;
};
export type ExecProcessHandle = {
    session: ProcessSession;
    startedAt: number;
    pid?: number;
    promise: Promise<ExecProcessOutcome>;
    kill: () => void;
    /** Immediately suppress all future `onUpdate` calls for this handle. */
    disableUpdates: () => void;
};
export declare function renderExecHostLabel(host: ExecHost): "gateway" | "node" | "sandbox";
export declare function renderExecTargetLabel(target: ExecTarget): "auto" | "gateway" | "node" | "sandbox";
export declare function isRequestedExecTargetAllowed(params: {
    configuredTarget: ExecTarget;
    requestedTarget: ExecTarget;
    sandboxAvailable?: boolean;
}): boolean;
export declare function resolveExecTarget(params: {
    configuredTarget?: ExecTarget;
    requestedTarget?: ExecTarget | null;
    elevatedRequested: boolean;
    sandboxAvailable: boolean;
}): {
    configuredTarget: ExecTarget;
    requestedTarget: ExecTarget | null;
    selectedTarget: ExecTarget;
    effectiveHost: ExecHost;
};
export declare function normalizeNotifyOutput(value: string): string;
export declare function applyShellPath(env: Record<string, string>, shellPath?: string | null): void;
export declare function createApprovalSlug(id: string): string;
export declare function buildApprovalPendingMessage(params: {
    warningText?: string;
    approvalSlug: string;
    approvalId: string;
    allowedDecisions?: readonly ExecApprovalDecision[];
    command: string;
    cwd: string | undefined;
    host: "gateway" | "node";
    nodeId?: string;
}): string;
export declare function resolveApprovalRunningNoticeMs(value?: number): number;
export declare function emitExecSystemEvent(text: string, opts: {
    sessionKey?: string;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
}): void;
export { renderExecUpdateText } from "./bash-tools.exec-output.js";
export declare function formatExecFailureReason(params: {
    failureKind: ExecExitFailureKind;
    exitSignal: NodeJS.Signals | number | null;
    timeoutSec: number | null | undefined;
}): string;
export declare function buildExecExitOutcome(params: {
    exit: RunExit;
    aggregated: string;
    durationMs: number;
    timeoutSec: number | null | undefined;
}): ExecProcessOutcome;
export declare function buildExecRuntimeErrorOutcome(params: {
    error: unknown;
    aggregated: string;
    durationMs: number;
}): ExecProcessOutcome;
export declare function runExecProcess(opts: {
    command: string;
    execCommand?: string;
    workdir: string;
    env: Record<string, string>;
    sandbox?: BashSandboxConfig;
    containerWorkdir?: string | null;
    usePty: boolean;
    warnings: string[];
    maxOutput: number;
    pendingMaxOutput: number;
    notifyOnExit: boolean;
    notifyOnExitEmptySuccess?: boolean;
    scopeKey?: string;
    sessionKey?: string;
    notifyDeliveryContext?: DeliveryContext;
    timeoutSec: number | null;
    onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
}): Promise<ExecProcessHandle>;
