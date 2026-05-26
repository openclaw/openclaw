import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { S as MarkdownTableMode } from "./types.base-DS--yneR.js";
import { m as ResolvedReactionLevel, p as ReactionLevel } from "./types.channels-C67UBRPK.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { P as MessageReceipt } from "./types-CxkJAgkR.js";
import { y as ChannelMessageActionAdapter } from "./types.core-BkmTlRzr.js";
import { y as BackoffPolicy } from "./wsl-DGjWf35r.js";
import { r as waitForTransportReady } from "./transport-ready-CRskTZ8O.js";
//#region extensions/signal/src/format.d.ts
type SignalTextStyle = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";
type SignalTextStyleRange = {
  start: number;
  length: number;
  style: SignalTextStyle;
};
type SignalFormattedText = {
  text: string;
  styles: SignalTextStyleRange[];
};
type SignalMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};
declare function markdownToSignalText(markdown: string, options?: SignalMarkdownOptions): SignalFormattedText;
declare function markdownToSignalTextChunks(markdown: string, limit: number, options?: SignalMarkdownOptions): SignalFormattedText[];
//#endregion
//#region extensions/signal/src/message-actions.d.ts
declare const signalMessageActions: ChannelMessageActionAdapter;
//#endregion
//#region extensions/signal/src/monitor.d.ts
type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  accountId?: string;
  config?: OpenClawConfig;
  baseUrl?: string;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  cliPath?: string;
  httpHost?: string;
  httpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  reconnectPolicy?: Partial<BackoffPolicy>;
  waitForTransportReady?: typeof waitForTransportReady;
};
declare function monitorSignalProvider(opts?: MonitorSignalOpts): Promise<void>;
//#endregion
//#region extensions/signal/src/reaction-level.d.ts
type SignalReactionLevel = ReactionLevel;
type ResolvedSignalReactionLevel = ResolvedReactionLevel;
/**
 * Resolve the effective reaction level and its implications for Signal.
 *
 * Levels:
 * - "off": No reactions at all
 * - "ack": Only automatic ack reactions (👀 when processing), no agent reactions
 * - "minimal": Agent can react, but sparingly (default)
 * - "extensive": Agent can react liberally
 */
declare function resolveSignalReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedSignalReactionLevel;
//#endregion
//#region extensions/signal/src/send.d.ts
type SignalSendOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
};
type SignalSendResult = {
  messageId: string;
  timestamp?: number;
  receipt: MessageReceipt;
};
type SignalRpcOpts = Pick<SignalSendOpts, "cfg" | "baseUrl" | "account" | "accountId" | "timeoutMs">;
type SignalReceiptType = "read" | "viewed";
declare function sendMessageSignal(to: string, text: string, opts: SignalSendOpts): Promise<SignalSendResult>;
declare function sendTypingSignal(to: string, opts: SignalRpcOpts & {
  stop?: boolean;
}): Promise<boolean>;
declare function sendReadReceiptSignal(to: string, targetTimestamp: number, opts: SignalRpcOpts & {
  type?: SignalReceiptType;
}): Promise<boolean>;
//#endregion
export { markdownToSignalTextChunks as _, sendMessageSignal as a, ResolvedSignalReactionLevel as c, MonitorSignalOpts as d, monitorSignalProvider as f, markdownToSignalText as g, SignalTextStyleRange as h, SignalSendResult as i, SignalReactionLevel as l, SignalFormattedText as m, SignalRpcOpts as n, sendReadReceiptSignal as o, signalMessageActions as p, SignalSendOpts as r, sendTypingSignal as s, SignalReceiptType as t, resolveSignalReactionLevel as u };