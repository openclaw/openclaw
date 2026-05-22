import { _ as GroupPolicy } from "./types.base-B1xU9TH3.js";
//#region extensions/zalo/src/group-access.d.ts
declare function resolveZaloRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};
//#endregion
export { resolveZaloRuntimeGroupPolicy as t };