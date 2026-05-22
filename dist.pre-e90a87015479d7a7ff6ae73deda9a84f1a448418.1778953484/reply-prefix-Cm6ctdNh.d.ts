import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { r as GetReplyOptions } from "./get-reply-options.types-CEbMlRdT.js";
import { i as ResponsePrefixContext } from "./typing-DhV8q8je.js";

//#region src/channels/reply-prefix.d.ts
type ModelSelectionContext = Parameters<NonNullable<GetReplyOptions["onModelSelected"]>>[0];
type ReplyPrefixContextBundle = {
  prefixContext: ResponsePrefixContext;
  responsePrefix?: string;
  responsePrefixContextProvider: () => ResponsePrefixContext;
  onModelSelected: (ctx: ModelSelectionContext) => void;
};
type ReplyPrefixOptions = Pick<ReplyPrefixContextBundle, "responsePrefix" | "responsePrefixContextProvider" | "onModelSelected">;
declare function createReplyPrefixContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixContextBundle;
declare function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixOptions;
//#endregion
export { createReplyPrefixOptions as i, ReplyPrefixOptions as n, createReplyPrefixContext as r, ReplyPrefixContextBundle as t };