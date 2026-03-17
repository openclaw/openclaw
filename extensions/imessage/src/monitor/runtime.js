import { createNonExitingRuntime } from "../../../../src/runtime.js";
import { normalizeStringEntries } from "../../../../src/shared/string-normalization.js";
function resolveRuntime(opts) {
  return opts.runtime ?? createNonExitingRuntime();
}
function normalizeAllowList(list) {
  return normalizeStringEntries(list);
}
export {
  normalizeAllowList,
  resolveRuntime
};
