import { n as TimeFormatPreference } from "./date-time-WJbJXOrS.js";

//#region src/agents/current-time.d.ts
type CronStyleNow = {
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
declare function resolveCronStyleNow(cfg: TimeConfigLike, nowMs: number): CronStyleNow;
declare function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number): string;
//#endregion
export { appendCronStyleCurrentTimeLine as n, resolveCronStyleNow as r, CronStyleNow as t };