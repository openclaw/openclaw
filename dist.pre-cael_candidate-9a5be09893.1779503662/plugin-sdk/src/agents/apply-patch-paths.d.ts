import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
export type ApplyPatchPathExtractionOptions = {
    /** Tool execution cwd. Defaults to process.cwd(), matching createApplyPatchTool. */
    cwd?: string;
    /** Sandbox bridge used by apply_patch execution, when the tool runs in a sandbox. */
    sandbox?: {
        root: string;
        bridge: SandboxFsBridge;
    };
};
/**
 * Walk an apply_patch envelope and return every destination path found, in
 * the order they appear. Duplicates are de-duplicated (the same file may be
 * referenced multiple times within a single envelope). Returns `[]` for any
 * input that is not a recognised envelope.
 */
export declare function extractApplyPatchTargetPaths(input: unknown, options?: ApplyPatchPathExtractionOptions): string[];
