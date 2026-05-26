import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import type { CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";
export type CronDeliveryPlan = {
    mode: CronDeliveryMode;
    channel?: CronMessageChannel;
    to?: string;
    threadId?: string | number;
    /** Explicit channel account id from the delivery config, if set. */
    accountId?: string;
    source: "delivery";
    requested: boolean;
};
export declare function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan;
export type CronFailureDeliveryPlan = {
    mode: "announce" | "webhook";
    channel?: CronMessageChannel;
    to?: string;
    accountId?: string;
};
export type CronFailureDestinationInput = {
    channel?: CronMessageChannel;
    to?: string;
    accountId?: string;
    mode?: "announce" | "webhook";
};
export declare function resolveFailureDestination(job: CronJob, globalConfig?: CronFailureDestinationConfig): CronFailureDeliveryPlan | null;
