import { t as ChannelId } from "./channel-id.types-_c58kC27.js";
//#region src/security/dm-policy-shared.d.ts
declare function resolvePinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null;
declare function resolveEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
};
type DmGroupAccessDecision = "allow" | "block" | "pairing";
declare const DM_GROUP_ACCESS_REASON: {
  readonly GROUP_POLICY_ALLOWED: "group_policy_allowed";
  readonly GROUP_POLICY_DISABLED: "group_policy_disabled";
  readonly GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist";
  readonly GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted";
  readonly DM_POLICY_OPEN: "dm_policy_open";
  readonly DM_POLICY_DISABLED: "dm_policy_disabled";
  readonly DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted";
  readonly DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required";
  readonly DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted";
};
type DmGroupAccessReasonCode = (typeof DM_GROUP_ACCESS_REASON)[keyof typeof DM_GROUP_ACCESS_REASON];
declare function resolveOpenDmAllowlistAccess(params: {
  effectiveAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): {
  decision: Extract<DmGroupAccessDecision, "allow" | "block">;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};
type DmGroupAccessInputParams = {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
};
declare function readStoreAllowFromForDmPolicy(params: {
  provider: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<string[]>;
declare function resolveDmGroupAccessDecision(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  effectiveAllowFrom: Array<string | number>;
  effectiveGroupAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};
declare function resolveDmGroupAccessWithLists(params: DmGroupAccessInputParams): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
};
declare function resolveDmGroupAccessWithCommandGate(params: DmGroupAccessInputParams & {
  command?: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
  };
}): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
};
declare function resolveDmAllowState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}>;
//#endregion
export { resolveDmAllowState as a, resolveDmGroupAccessWithLists as c, resolvePinnedMainDmOwnerFromAllowlist as d, readStoreAllowFromForDmPolicy as i, resolveEffectiveAllowFromLists as l, DmGroupAccessDecision as n, resolveDmGroupAccessDecision as o, DmGroupAccessReasonCode as r, resolveDmGroupAccessWithCommandGate as s, DM_GROUP_ACCESS_REASON as t, resolveOpenDmAllowlistAccess as u };