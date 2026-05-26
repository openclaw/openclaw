import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
declare namespace command_status_runtime_d_exports {
  export { ResolveDirectStatusReplyForSessionParams, resolveDirectStatusReplyForSession$1 as resolveDirectStatusReplyForSession };
}
type ResolveDirectStatusReplyForSessionParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  channel: string;
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
};
declare function resolveDirectStatusReplyForSession$1(params: ResolveDirectStatusReplyForSessionParams): Promise<ReplyPayload | undefined>;
//#endregion
//#region src/plugin-sdk/command-status-runtime.d.ts
type CommandStatusRuntime = typeof command_status_runtime_d_exports;
declare const resolveDirectStatusReplyForSession: CommandStatusRuntime["resolveDirectStatusReplyForSession"];
//#endregion
export { ResolveDirectStatusReplyForSessionParams as n, resolveDirectStatusReplyForSession as t };