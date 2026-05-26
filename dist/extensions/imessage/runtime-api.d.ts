import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-DfCsc96R.js";
import { n as RuntimeEnv } from "../../runtime-CZFxIuHh.js";
import { N as MessageReceipt } from "../../types-Bu3TUX-L.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-1gFCH89g.js";
import { n as ChannelPlugin } from "../../types.public-BfuQlAVf.js";
import { n as PluginRuntime } from "../../types-DtDIgr2k.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CjXvdXRL.js";
import { d as getChatChannelMeta } from "../../core-BW4coGrc.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-N7LXvAKY.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DoVbZEu3.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-zpr3QJIn.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-YRDypMy8.js";
import { g as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-CCl70z4e.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BXuE3MM3.js";
import { a as looksLikeIMessageTargetId, o as normalizeIMessageMessagingTarget, r as probeIMessage, s as ResolvedIMessageAccount, t as IMessageProbe } from "../../probe-ExzEDmd6.js";
import { d as resolveIMessageGroupRequireMention, f as resolveIMessageGroupToolPolicy, n as IMessageService } from "../../targets-DgPPvwxy.js";

//#region extensions/imessage/src/config-accessors.d.ts
declare function resolveIMessageConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[];
declare function resolveIMessageConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined;
//#endregion
//#region extensions/imessage/src/monitor/types.d.ts
type MonitorIMessageOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  cliPath?: string;
  dbPath?: string;
  accountId?: string;
  config?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  includeAttachments?: boolean;
  mediaMaxMb?: number;
  requireMention?: boolean;
};
//#endregion
//#region extensions/imessage/src/monitor/monitor-provider.d.ts
declare function monitorIMessageProvider(opts?: MonitorIMessageOpts): Promise<void>;
//#endregion
//#region extensions/imessage/src/client.d.ts
type IMessageRpcNotification = {
  method: string;
  params?: unknown;
};
type IMessageRpcClientOptions = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
  onNotification?: (msg: IMessageRpcNotification) => void;
};
declare class IMessageRpcClient {
  private readonly cliPath;
  private readonly dbPath?;
  private readonly runtime?;
  private readonly onNotification?;
  private readonly pending;
  private readonly closed;
  private closedResolve;
  private child;
  private reader;
  private nextId;
  private publicProcessError;
  constructor(opts?: IMessageRpcClientOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForClose(): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>, opts?: {
    timeoutMs?: number;
  }): Promise<T>;
  private handleLine;
  private recordProcessDiagnostic;
  private buildCloseError;
  private failAll;
}
//#endregion
//#region extensions/imessage/src/send.d.ts
type IMessageSendOpts = {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  accountId?: string;
  replyToId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
  config: OpenClawConfig;
  account?: ResolvedIMessageAccount;
  resolveAttachmentImpl?: (mediaUrl: string, maxBytes: number, options?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  }) => Promise<{
    path: string;
    contentType?: string;
  }>;
  createClient?: (params: {
    cliPath: string;
    dbPath?: string;
  }) => Promise<IMessageRpcClient>;
};
type IMessageSendResult = {
  messageId: string;
  sentText: string;
  echoText?: string;
  receipt: MessageReceipt;
};
declare function sendMessageIMessage(to: string, text: string, opts: IMessageSendOpts): Promise<IMessageSendResult>;
//#endregion
//#region extensions/imessage/src/actions.d.ts
declare const imessageMessageActions: ChannelMessageActionAdapter;
//#endregion
//#region extensions/imessage/src/runtime.d.ts
declare const setIMessageRuntime: (next: PluginRuntime) => void;
//#endregion
//#region extensions/imessage/runtime-api.d.ts
type IMessageAccountConfig = Omit<NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>, "accounts" | "defaultAccount">;
//#endregion
export { type ChannelPlugin, DEFAULT_ACCOUNT_ID, IMessageAccountConfig, IMessageConfigSchema, type IMessageProbe, type MonitorIMessageOpts, PAIRING_APPROVED_MESSAGE, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, chunkTextForOutbound, collectStatusIssuesFromLastError, formatTrimmedAllowFromEntries, getChatChannelMeta, imessageMessageActions, looksLikeIMessageTargetId, monitorIMessageProvider, normalizeIMessageMessagingTarget, probeIMessage, resolveChannelMediaMaxBytes, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, sendMessageIMessage, setIMessageRuntime };