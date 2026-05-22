import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export type CodexNativeAssetHit = {
    kind: "skill" | "plugin" | "config" | "hooks";
    path: string;
};
export declare function scanCodexNativeAssets(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<CodexNativeAssetHit[]>;
export declare function collectCodexNativeAssetWarnings(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
