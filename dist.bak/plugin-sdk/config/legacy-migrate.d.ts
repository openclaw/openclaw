import type { OpenClawConfig } from "./types.js";
export declare function migrateLegacyConfig(raw: unknown): {
    config: OpenClawConfig | null;
    changes: string[];
};
