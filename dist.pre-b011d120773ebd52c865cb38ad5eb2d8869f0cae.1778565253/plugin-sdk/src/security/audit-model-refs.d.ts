import type { OpenClawConfig } from "../config/types.openclaw.js";
export type AuditModelRef = {
    id: string;
    source: string;
};
export declare function collectAuditModelRefs(cfg: OpenClawConfig): AuditModelRef[];
