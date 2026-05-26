import type { OpenClawConfig } from "../../config/types.js";
export type DirectoryConfigParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    query?: string | null;
    limit?: number | null;
};
