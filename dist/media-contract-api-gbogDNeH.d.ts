import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/imessage/src/media-contract.d.ts
declare const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS: readonly ["/Users/*/Library/Messages/Attachments"];
declare function resolveIMessageAttachmentRoots(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[];
declare function resolveIMessageRemoteAttachmentRoots(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[];
//#endregion
export { resolveIMessageAttachmentRoots as n, resolveIMessageRemoteAttachmentRoots as r, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS as t };