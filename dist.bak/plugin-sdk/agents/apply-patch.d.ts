import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
export type ApplyPatchSummary = {
    added: string[];
    modified: string[];
    deleted: string[];
};
export type ApplyPatchResult = {
    summary: ApplyPatchSummary;
    text: string;
};
export type ApplyPatchToolDetails = {
    summary: ApplyPatchSummary;
};
type SandboxApplyPatchConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
type ApplyPatchOptions = {
    cwd: string;
    sandbox?: SandboxApplyPatchConfig;
    /** Restrict patch paths to the workspace root (cwd). Default: true. Set false to opt out. */
    workspaceOnly?: boolean;
    signal?: AbortSignal;
};
declare const applyPatchSchema: import("@sinclair/typebox").TObject<{
    input: import("@sinclair/typebox").TString;
}>;
export declare function createApplyPatchTool(options?: {
    cwd?: string;
    sandbox?: SandboxApplyPatchConfig;
    workspaceOnly?: boolean;
}): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails>;
export declare function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult>;
export {};
