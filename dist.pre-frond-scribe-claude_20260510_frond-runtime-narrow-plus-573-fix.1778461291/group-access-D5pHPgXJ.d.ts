import { _ as GroupPolicy } from "./types.base-CN1BlTRP.js";
import { a as SenderGroupAccessDecision } from "./group-access-DK5RmZHa.js";

//#region extensions/zalo/src/group-access.d.ts
declare function resolveZaloRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};
declare function evaluateZaloGroupAccess(params: {
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
}): SenderGroupAccessDecision;
//#endregion
export { resolveZaloRuntimeGroupPolicy as n, evaluateZaloGroupAccess as t };