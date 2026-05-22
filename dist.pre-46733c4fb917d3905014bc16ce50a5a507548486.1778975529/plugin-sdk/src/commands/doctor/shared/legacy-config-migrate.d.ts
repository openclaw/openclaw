import type { OpenClawConfig } from "../../../config/types.js";
export declare function migrateLegacyConfig(raw: unknown): {
    config: OpenClawConfig | null;
    changes: string[];
    partiallyValid?: boolean;
};
