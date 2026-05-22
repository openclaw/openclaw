import { _ as GroupPolicy } from "./types.base-YD5s4YZy.js";
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