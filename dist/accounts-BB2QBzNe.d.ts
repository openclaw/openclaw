import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { P as MessageReceipt } from "./types-CxkJAgkR.js";
//#region extensions/zalouser/src/zca-constants.d.ts
declare const TextStyle: {
  readonly Bold: "b";
  readonly Italic: "i";
  readonly Underline: "u";
  readonly StrikeThrough: "s";
  readonly Red: "c_db342e";
  readonly Orange: "c_f27806";
  readonly Yellow: "c_f7b503";
  readonly Green: "c_15a85f";
  readonly Small: "f_13";
  readonly Big: "f_18";
  readonly UnorderedList: "lst_1";
  readonly OrderedList: "lst_2";
  readonly Indent: "ind_$";
};
type TextStyleValue = (typeof TextStyle)[keyof typeof TextStyle];
type Style = {
  start: number;
  len: number;
  st: Exclude<TextStyleValue, typeof TextStyle.Indent>;
} | {
  start: number;
  len: number;
  st: typeof TextStyle.Indent;
  indentSize?: number;
};
//#endregion
//#region extensions/zalouser/src/types.d.ts
type ZcaFriend = {
  userId: string;
  displayName: string;
  avatar?: string;
};
type ZaloGroup = {
  groupId: string;
  name: string;
  memberCount?: number;
};
type ZaloGroupMember = {
  userId: string;
  displayName: string;
  avatar?: string;
};
type ZcaUserInfo = {
  userId: string;
  displayName: string;
  avatar?: string;
};
type ZaloSendOptions = {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  textMode?: "markdown" | "plain";
  textChunkMode?: "length" | "newline";
  textChunkLimit?: number;
  textStyles?: Style[];
};
type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  receipt: MessageReceipt;
  error?: string;
};
type ZaloAuthStatus = {
  connected: boolean;
  message: string;
};
type ZalouserToolConfig = {
  allow?: string[];
  deny?: string[];
};
type ZalouserGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  tools?: ZalouserToolConfig;
};
type ZalouserSharedConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  dangerouslyAllowNameMatching?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  historyLimit?: number;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, ZalouserGroupConfig>;
  messagePrefix?: string;
  responsePrefix?: string;
};
type ZalouserAccountConfig = ZalouserSharedConfig;
type ResolvedZalouserAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: ZalouserAccountConfig;
};
//#endregion
//#region extensions/zalouser/src/accounts.d.ts
declare const listZalouserAccountIds: (cfg: OpenClawConfig) => string[], resolveDefaultZalouserAccountId: (cfg: OpenClawConfig) => string;
declare function resolveZalouserAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZalouserAccount;
declare function getZcaUserInfo(profile: string): Promise<{
  userId?: string;
  displayName?: string;
} | null>;
declare function checkZcaAuthenticated(profile: string): Promise<boolean>;
//#endregion
export { resolveZalouserAccountSync as a, ZaloGroup as c, ZaloSendResult as d, ZcaFriend as f, resolveDefaultZalouserAccountId as i, ZaloGroupMember as l, getZcaUserInfo as n, ResolvedZalouserAccount as o, ZcaUserInfo as p, listZalouserAccountIds as r, ZaloAuthStatus as s, checkZcaAuthenticated as t, ZaloSendOptions as u };