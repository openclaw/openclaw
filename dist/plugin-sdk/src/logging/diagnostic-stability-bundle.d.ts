import { type DiagnosticStabilitySnapshot } from "./diagnostic-stability.js";
export declare const DIAGNOSTIC_STABILITY_BUNDLE_VERSION = 1;
export declare const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT = 1000;
export declare const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION = 20;
export declare const MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES: number;
export type DiagnosticStabilityBundle = {
    version: typeof DIAGNOSTIC_STABILITY_BUNDLE_VERSION;
    generatedAt: string;
    reason: string;
    process: {
        pid: number;
        platform: NodeJS.Platform;
        arch: string;
        node: string;
        uptimeMs: number;
    };
    host: {
        hostname: string;
    };
    error?: {
        name?: string;
        code?: string;
        message?: string;
    };
    snapshot: DiagnosticStabilitySnapshot;
};
export type WriteDiagnosticStabilityBundleResult = {
    status: "written";
    path: string;
    bundle: DiagnosticStabilityBundle;
} | {
    status: "skipped";
    reason: "empty";
} | {
    status: "failed";
    error: unknown;
};
export type WriteDiagnosticStabilityBundleOptions = {
    reason: string;
    error?: unknown;
    includeEmpty?: boolean;
    limit?: number;
    now?: Date;
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    retention?: number;
};
export type DiagnosticStabilityBundleLocationOptions = {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
};
export type DiagnosticStabilityBundleFile = {
    path: string;
    mtimeMs: number;
};
export type ReadDiagnosticStabilityBundleResult = {
    status: "found";
    path: string;
    mtimeMs: number;
    bundle: DiagnosticStabilityBundle;
} | {
    status: "missing";
    dir: string;
} | {
    status: "failed";
    path?: string;
    error: unknown;
};
export type DiagnosticStabilityBundleFailureWriteOutcome = {
    status: "written";
    message: string;
    path: string;
} | {
    status: "failed";
    message: string;
    error: unknown;
} | {
    status: "skipped";
    reason: "empty";
};
export type WriteDiagnosticStabilityBundleForFailureOptions = Omit<WriteDiagnosticStabilityBundleOptions, "error" | "includeEmpty" | "reason">;
export declare function resolveDiagnosticStabilityBundleDir(options?: DiagnosticStabilityBundleLocationOptions): string;
export declare function listDiagnosticStabilityBundleFilesSync(options?: DiagnosticStabilityBundleLocationOptions): DiagnosticStabilityBundleFile[];
export declare function readDiagnosticStabilityBundleFileSync(file: string): ReadDiagnosticStabilityBundleResult;
export declare function readLatestDiagnosticStabilityBundleSync(options?: DiagnosticStabilityBundleLocationOptions): ReadDiagnosticStabilityBundleResult;
export declare function writeDiagnosticStabilityBundleSync(options: WriteDiagnosticStabilityBundleOptions): WriteDiagnosticStabilityBundleResult;
export declare function writeDiagnosticStabilityBundleForFailureSync(reason: string, error?: unknown, options?: WriteDiagnosticStabilityBundleForFailureOptions): DiagnosticStabilityBundleFailureWriteOutcome;
export declare function installDiagnosticStabilityFatalHook(options?: WriteDiagnosticStabilityBundleForFailureOptions): void;
export declare function uninstallDiagnosticStabilityFatalHook(): void;
export declare function resetDiagnosticStabilityBundleForTest(): void;
