import { createNonExitingRuntime, type RuntimeEnv } from "../../../../src/runtime.js";
import { normalizeStringEntries } from "../../../../src/shared/string-normalization.js";
import type { MonitorIMessageOpts } from "./types.js";

export function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}

export function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}
