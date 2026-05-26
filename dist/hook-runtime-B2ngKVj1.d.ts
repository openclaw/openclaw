import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-Cr5jFRhS.js";
import { t as FinalizedMsgContext } from "./templating-BcdAlwzB.js";
import { Ht as PluginHookMessageSentEvent, It as PluginHookInboundClaimContext, Lt as PluginHookInboundClaimEvent, Rt as PluginHookMessageContext, zt as PluginHookMessageReceivedEvent } from "./hook-types-CECscVcN.js";
import { a as MessagePreprocessedHookContext, d as MessageTranscribedHookContext, l as MessageSentHookContext, s as MessageReceivedHookContext } from "./internal-hooks-DrhDdnAX.js";

//#region src/hooks/fire-and-forget.d.ts
type FireAndForgetBoundedHookOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
};
declare function formatHookErrorForLog(err: unknown): string;
declare function fireAndForgetHook(task: Promise<unknown>, label: string, logger?: (message: string) => void): void;
declare function fireAndForgetBoundedHook(task: () => Promise<unknown>, label: string, logger?: (message: string) => void, options?: FireAndForgetBoundedHookOptions): void;
//#endregion
//#region src/hooks/message-hook-mappers.d.ts
type CanonicalInboundMessageHookContext = {
  from: string;
  to?: string;
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  provider?: string;
  surface?: string;
  threadId?: string | number;
  mediaPath?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaUrls?: string[];
  mediaTypes?: string[];
  originatingChannel?: string;
  originatingTo?: string;
  guildId?: string;
  channelName?: string;
  isGroup: boolean;
  groupId?: string;
  topicName?: string;
  trace?: DiagnosticTraceContext;
  callDepth?: number;
};
type CanonicalSentMessageHookContext = {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  trace?: DiagnosticTraceContext;
  callDepth?: number;
  isGroup?: boolean;
  groupId?: string;
};
declare function deriveInboundMessageHookContext(ctx: FinalizedMsgContext, overrides?: {
  content?: string;
  messageId?: string;
}): CanonicalInboundMessageHookContext;
declare function buildCanonicalSentMessageHookContext(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  trace?: DiagnosticTraceContext;
  callDepth?: number;
  isGroup?: boolean;
  groupId?: string;
}): CanonicalSentMessageHookContext;
declare function toPluginMessageContext(canonical: CanonicalInboundMessageHookContext | CanonicalSentMessageHookContext): PluginHookMessageContext;
declare function toPluginInboundClaimContext(canonical: CanonicalInboundMessageHookContext): PluginHookInboundClaimContext;
declare function toPluginInboundClaimEvent(canonical: CanonicalInboundMessageHookContext, extras?: {
  commandAuthorized?: boolean;
  wasMentioned?: boolean;
}): PluginHookInboundClaimEvent;
declare function toPluginMessageReceivedEvent(canonical: CanonicalInboundMessageHookContext): PluginHookMessageReceivedEvent;
declare function toPluginMessageSentEvent(canonical: CanonicalSentMessageHookContext): PluginHookMessageSentEvent;
declare function toInternalMessageReceivedContext(canonical: CanonicalInboundMessageHookContext): MessageReceivedHookContext;
declare function toInternalMessageTranscribedContext(canonical: CanonicalInboundMessageHookContext, cfg: OpenClawConfig): MessageTranscribedHookContext & {
  cfg: OpenClawConfig;
};
declare function toInternalMessagePreprocessedContext(canonical: CanonicalInboundMessageHookContext, cfg: OpenClawConfig): MessagePreprocessedHookContext & {
  cfg: OpenClawConfig;
};
declare function toInternalMessageSentContext(canonical: CanonicalSentMessageHookContext): MessageSentHookContext;
//#endregion
export { formatHookErrorForLog as _, toInternalMessagePreprocessedContext as a, toInternalMessageTranscribedContext as c, toPluginMessageContext as d, toPluginMessageReceivedEvent as f, fireAndForgetHook as g, fireAndForgetBoundedHook as h, deriveInboundMessageHookContext as i, toPluginInboundClaimContext as l, FireAndForgetBoundedHookOptions as m, CanonicalSentMessageHookContext as n, toInternalMessageReceivedContext as o, toPluginMessageSentEvent as p, buildCanonicalSentMessageHookContext as r, toInternalMessageSentContext as s, CanonicalInboundMessageHookContext as t, toPluginInboundClaimEvent as u };