import type { AnyAgentTool } from "./pi-tools.types.js";
/**
 * When the upstream edit tool throws after having already written (e.g. generateDiffString fails),
 * the file may be correctly updated but the tool reports failure. This wrapper catches errors and
 * if the target file on disk contains the intended newText, returns success so we don't surface
 * a false "edit failed" to the user (fixes #32333, same pattern as #30773 for write).
 */
export declare function wrapHostEditToolWithPostWriteRecovery(base: AnyAgentTool, root: string): AnyAgentTool;
