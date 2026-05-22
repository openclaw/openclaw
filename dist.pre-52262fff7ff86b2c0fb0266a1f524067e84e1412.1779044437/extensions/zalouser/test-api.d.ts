import { a as resolveZalouserAccountSync, c as ZaloGroup, d as ZaloSendResult, f as ZcaFriend, i as resolveDefaultZalouserAccountId, l as ZaloGroupMember, n as getZcaUserInfo, p as ZcaUserInfo, r as listZalouserAccountIds, s as ZaloAuthStatus, t as checkZcaAuthenticated, u as ZaloSendOptions } from "../../accounts-C3mGnpTA.js";

//#region extensions/zalouser/src/send.d.ts
type ZalouserSendOptions = ZaloSendOptions;
type ZalouserSendResult = ZaloSendResult;
declare function sendMessageZalouser(threadId: string, text: string, options?: ZalouserSendOptions): Promise<ZalouserSendResult>;
//#endregion
//#region extensions/zalouser/src/session-route.d.ts
declare function parseZalouserOutboundTarget(raw: string): {
  threadId: string;
  isGroup: boolean;
};
//#endregion
//#region extensions/zalouser/src/zalo-js.d.ts
declare function checkZaloAuthenticated(profileInput?: string | null): Promise<boolean>;
declare function getZaloUserInfo(profileInput?: string | null): Promise<ZcaUserInfo | null>;
declare function listZaloFriendsMatching(profileInput: string | null | undefined, query?: string | null): Promise<ZcaFriend[]>;
declare function listZaloGroupsMatching(profileInput: string | null | undefined, query?: string | null): Promise<ZaloGroup[]>;
declare function listZaloGroupMembers(profileInput: string | null | undefined, groupId: string): Promise<ZaloGroupMember[]>;
declare function startZaloQrLogin(params: {
  profile?: string | null;
  force?: boolean;
  timeoutMs?: number;
}): Promise<{
  qrDataUrl?: string;
  message: string;
}>;
declare function waitForZaloQrLogin(params: {
  profile?: string | null;
  timeoutMs?: number;
}): Promise<ZaloAuthStatus>;
declare function logoutZaloProfile(profileInput?: string | null): Promise<{
  cleared: boolean;
  loggedOut: boolean;
  message: string;
}>;
declare function resolveZaloGroupsByEntries(params: {
  profile?: string | null;
  entries: string[];
}): Promise<Array<{
  input: string;
  resolved: boolean;
  id?: string;
}>>;
declare function resolveZaloAllowFromEntries(params: {
  profile?: string | null;
  entries: string[];
}): Promise<Array<{
  input: string;
  resolved: boolean;
  id?: string;
  note?: string;
}>>;
//#endregion
export { checkZaloAuthenticated, checkZcaAuthenticated, getZaloUserInfo, getZcaUserInfo, listZaloFriendsMatching, listZaloGroupMembers, listZaloGroupsMatching, listZalouserAccountIds, logoutZaloProfile, parseZalouserOutboundTarget, resolveDefaultZalouserAccountId, resolveZaloAllowFromEntries, resolveZaloGroupsByEntries, resolveZalouserAccountSync, sendMessageZalouser, startZaloQrLogin, waitForZaloQrLogin };