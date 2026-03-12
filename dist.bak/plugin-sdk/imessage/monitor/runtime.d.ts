import { type RuntimeEnv } from "../../runtime.js";
import type { MonitorIMessageOpts } from "./types.js";
export declare function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv;
export declare function normalizeAllowList(list?: Array<string | number>): string[];
