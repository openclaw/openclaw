import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type MediaKind } from "./constants.js";
export declare function resolveConfiguredMediaMaxBytes(cfg?: OpenClawConfig): number | undefined;
export declare function resolveGeneratedMediaMaxBytes(cfg: OpenClawConfig | undefined, kind: MediaKind): number;
export declare function resolveChannelAccountMediaMaxMb(params: {
    cfg: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
}): number | undefined;
