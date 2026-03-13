import { type TimeFormatPreference } from "./date-time.js";
export type CronStyleNow = {
    userTimezone: string;
    formattedTime: string;
    timeLine: string;
};
type TimeConfigLike = {
    agents?: {
        defaults?: {
            userTimezone?: string;
            timeFormat?: TimeFormatPreference;
        };
    };
};
export declare function resolveCronStyleNow(cfg: TimeConfigLike, nowMs: number): CronStyleNow;
export declare function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number): string;
export {};
