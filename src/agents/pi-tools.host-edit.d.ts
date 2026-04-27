import type { AnyAgentTool } from "./pi-tools.types.js";
type EditToolRecoveryOptions = {
    root: string;
    readFile: (absolutePath: string) => Promise<string>;
};
/**
 * Recover from two edit-tool failure classes without changing edit semantics:
 * - exact-match mismatch errors become actionable by including current file contents
 * - post-write throws are converted back to success only if the file actually changed
 */
export declare function wrapEditToolWithRecovery(base: AnyAgentTool, options: EditToolRecoveryOptions): AnyAgentTool;
export {};
