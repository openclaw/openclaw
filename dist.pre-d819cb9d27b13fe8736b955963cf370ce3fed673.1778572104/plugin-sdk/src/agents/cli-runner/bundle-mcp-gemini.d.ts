import type { BundleMcpConfig } from "../../plugins/bundle-mcp.js";
export declare function writeGeminiSystemSettings(mergedConfig: BundleMcpConfig, inheritedEnv: Record<string, string> | undefined): Promise<{
    env: Record<string, string>;
    cleanup: () => Promise<void>;
}>;
