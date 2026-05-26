import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronDeliveryPreview, CronJob } from "./types.js";
export declare function resolveCronDeliveryPreview(params: {
    cfg: OpenClawConfig;
    defaultAgentId?: string;
    job: CronJob;
}): Promise<CronDeliveryPreview>;
export declare function resolveCronDeliveryPreviews(params: {
    cfg: OpenClawConfig;
    defaultAgentId?: string;
    jobs: CronJob[];
}): Promise<Record<string, CronDeliveryPreview>>;
