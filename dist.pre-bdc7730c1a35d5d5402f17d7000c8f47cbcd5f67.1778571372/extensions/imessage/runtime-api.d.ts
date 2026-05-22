import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-FZhPryJd.js";
import { n as RuntimeEnv } from "../../runtime-DRy59NVK.js";
import { N as MessageReceipt } from "../../types-BJJUY3hp.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-D5GEzFhB.js";
import { n as ChannelPlugin } from "../../types.public-CH2hYFDc.js";
import { n as PluginRuntime } from "../../types-4PahHl43.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DoRYUMiG.js";
import { d as getChatChannelMeta } from "../../core-D7I1oNSf.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-CWmyuAqF.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-HwLZ4IGS.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-DfxJPCFm.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-B8HVUHAD.js";
import { g as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DLLjcq30.js";
import { t as chunkTextForOutbound } from "../../text-chunking-Dg-3jS4Q.js";
import { a as looksLikeIMessageTargetId, o as normalizeIMessageMessagingTarget, r as probeIMessage, s as ResolvedIMessageAccount, t as IMessageProbe } from "../../probe-D8QTSojA.js";
import { d as resolveIMessageGroupRequireMention, f as resolveIMessageGroupToolPolicy, n as IMessageService } from "../../targets-D51jluLA.js";

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
  constructor(opts?: IMessageRpcClientOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForClose(): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>, opts?: {
    timeoutMs?: number;
  }): Promise<T>;
  private handleLine;
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