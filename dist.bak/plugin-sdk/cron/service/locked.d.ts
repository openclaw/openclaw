import type { CronServiceState } from "./state.js";
export declare function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T>;
