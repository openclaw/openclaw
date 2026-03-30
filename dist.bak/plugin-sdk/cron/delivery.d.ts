import type { CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";
export type CronDeliveryPlan = {
    mode: CronDeliveryMode;
    channel?: CronMessageChannel;
    to?: string;
    /** Explicit channel account id from the delivery config, if set. */
    accountId?: string;
    source: "delivery" | "payload";
    requested: boolean;
};
export declare function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan;
