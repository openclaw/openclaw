import type { CronDelivery, CronJobCreate } from "../types.js";
export declare function normalizeCronCreateDeliveryInput(input: CronJobCreate): CronJobCreate;
export declare function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined;
