import type { ResolvedBrowserProfile } from "../config.js";
import { shouldUsePlaywrightForAriaSnapshot, shouldUsePlaywrightForScreenshot } from "../profile-capabilities.js";
export type BrowserSnapshotPlan = {
    format: "ai" | "aria";
    mode?: "efficient";
    labels?: boolean;
    limit?: number;
    resolvedMaxChars?: number;
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    refsMode?: "aria" | "role";
    selectorValue?: string;
    frameSelectorValue?: string;
    wantsRoleSnapshot: boolean;
};
export declare function resolveSnapshotPlan(params: {
    profile: ResolvedBrowserProfile;
    query: Record<string, unknown>;
    hasPlaywright: boolean;
}): BrowserSnapshotPlan;
export { shouldUsePlaywrightForAriaSnapshot, shouldUsePlaywrightForScreenshot };
