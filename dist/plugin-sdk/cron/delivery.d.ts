import type { CliDeps } from "../cli/deps.js";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import type { OpenClawConfig } from "../config/types.js";
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
export declare function sendFailureNotificationAnnounce(deps: CliDeps, cfg: OpenClawConfig, agentId: string, jobId: string, target: {
    channel?: string;
    to?: string;
    accountId?: string;
}, message: string): Promise<void>;
