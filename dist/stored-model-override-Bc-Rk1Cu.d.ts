import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { o as SessionEntry } from "./types-ChLEnNVH.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
//#region src/channels/native-command-session-targets.d.ts
type ResolveNativeCommandSessionTargetsParams = {
  agentId: string;
  sessionPrefix: string;
  userId: string;
  targetSessionKey: string;
  boundSessionKey?: string;
  lowercaseSessionKey?: boolean;
};
declare function resolveNativeCommandSessionTargets(params: ResolveNativeCommandSessionTargetsParams): {
  sessionKey: string;
  commandTargetSessionKey: string;
};
//#endregion
//#region src/auto-reply/command-auth.d.ts
type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};
declare function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): CommandAuthorization;
//#endregion
//#region src/auto-reply/reply/stored-model-override.d.ts
type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
};
declare function resolveStoredModelOverride(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null;
//#endregion
export { ResolveNativeCommandSessionTargetsParams as a, resolveCommandAuthorization as i, resolveStoredModelOverride as n, resolveNativeCommandSessionTargets as o, CommandAuthorization as r, StoredModelOverride as t };