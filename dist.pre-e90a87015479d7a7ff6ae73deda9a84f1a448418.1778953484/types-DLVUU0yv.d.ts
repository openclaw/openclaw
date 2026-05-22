import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { t as ChannelId } from "./channel-id.types-Br_kWGpU.js";
import { i as resolveHumanDelayConfig, r as resolveEffectiveMessagesConfig } from "./identity-pYF88GSx.js";
import { J as ReadSessionUpdatedAt$1, X as UpdateLastRoute$1, Y as RecordSessionMetaFromInbound$1, o as PluginRuntimeCore } from "./types-core-BQms3m8n.js";
import { m as resolveStorePath } from "./store-oFJKyYQl.js";
import { _ as resolveChunkMode, f as chunkByNewline, g as chunkTextWithMode, h as chunkText, m as chunkMarkdownTextWithMode, n as ChannelOutboundAdapter, p as chunkMarkdownText, v as resolveTextChunkLimit } from "./outbound.types-BK1BT_uT.js";
import { n as ReplyDispatcher } from "./reply-dispatcher.types-D9-rHNlL.js";
import { s as CommandNormalizeOptions, u as ShouldHandleTextCommandsParams } from "./commands-registry.types-B6SgIgNo.js";
import { i as MatchesMentionWithExplicit$1, r as MatchesMentionPatterns$1, t as BuildMentionRegexes$1 } from "./mentions.types-CrrT0_vG.js";
import { n as RecordInboundSession$1 } from "./session.types-DhSo5mIh.js";
import { c as SessionBindingRecord } from "./session-binding.types-BsY78aJ7.js";
import { t as hasControlCommand } from "./command-detection-CgPryNwL.js";
import { t as ResolveMarkdownTableMode } from "./markdown-tables.types-Bc28CQUU.js";
import { t as convertMarkdownTables } from "./tables-DmSk-8f7.js";
import { n as DispatchReplyFromConfig } from "./dispatch-from-config.types-BOR5plL5.js";
import { t as finalizeInboundContext } from "./inbound-context-D6AGmnSS.js";
import { a as resolveEnvelopeFormatOptions, n as formatAgentEnvelope, r as formatInboundEnvelope } from "./envelope-Bp3mDi0f.js";
import { i as buildAgentSessionKey, o as resolveAgentRoute } from "./resolve-route-C4mzZ654.js";
import { n as ReadChannelAllowFromStoreForAccount, r as UpsertChannelPairingRequestForAccount } from "./pairing-store.types-CYAGMhJy.js";
import { t as buildPairingReply } from "./pairing-messages-BiZ7fo7-.js";
import { p as saveMediaBuffer } from "./store-DopRaz9l.js";
import { d as readRemoteMediaBuffer, f as saveRemoteMedia, p as saveResponseMedia, u as fetchRemoteMedia } from "./fetch-B3Re29qW.js";
import { n as getChannelActivity, r as recordChannelActivity } from "./channel-activity-D_nuuD32.js";
import { f as implicitMentionKindWhen, p as resolveInboundMentionDecision } from "./mention-gating-BXZqVFu4.js";
import { a as createAckReactionHandle, c as shouldAckReaction, o as removeAckReactionAfterReply, s as removeAckReactionHandleAfterReply } from "./ack-reactions-CdAdRVSW.js";
import { n as resolveChannelGroupPolicy, r as resolveChannelGroupRequireMention } from "./group-policy-BaxP7PI8.js";
import { n as createInboundDebouncer, r as resolveInboundDebounceMs } from "./inbound-debounce-cSq7nbep.js";
import { r as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-9cC3AqQV.js";
import { o as createReplyDispatcherWithTyping, t as DispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher.types-CFBngr-s.js";
import { r as buildChannelTurnContext } from "./context-DFJ82zWa.js";
import { a as runResolvedChannelTurn, i as runPreparedChannelTurn, r as runChannelTurn, t as dispatchAssembledChannelTurn } from "./kernel-Vyg30WbW.js";

//#region src/auto-reply/commands-registry.runtime-types.d.ts
type ShouldHandleTextCommands$1 = (params: ShouldHandleTextCommandsParams) => boolean;
//#endregion
//#region src/auto-reply/command-detection.runtime-types.d.ts
type IsControlCommandMessage$1 = (text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions) => boolean;
type ShouldComputeCommandAuthorized$1 = (text?: string, cfg?: OpenClawConfig, options?: CommandNormalizeOptions) => boolean;
//#endregion
//#region src/auto-reply/dispatch-dispatcher.d.ts
declare function settleReplyDispatcher(params: {
  dispatcher: ReplyDispatcher;
  onSettled?: () => void | Promise<void>;
}): Promise<void>;
declare function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T>;
//#endregion
//#region src/channels/plugins/outbound/load.types.d.ts
type LoadChannelOutboundAdapter = (id: ChannelId) => Promise<ChannelOutboundAdapter | undefined>;
//#endregion
//#region src/auto-reply/reply/reply-dispatcher.runtime-types.d.ts
type CreateReplyDispatcherWithTyping = typeof createReplyDispatcherWithTyping;
//#endregion
//#region src/plugins/runtime/types-channel.d.ts
type ShouldHandleTextCommands = ShouldHandleTextCommands$1;
type IsControlCommandMessage = IsControlCommandMessage$1;
type ShouldComputeCommandAuthorized = ShouldComputeCommandAuthorized$1;
type BuildMentionRegexes = BuildMentionRegexes$1;
type MatchesMentionPatterns = MatchesMentionPatterns$1;
type MatchesMentionWithExplicit = MatchesMentionWithExplicit$1;
type ReadSessionUpdatedAt = ReadSessionUpdatedAt$1;
type RecordSessionMetaFromInbound = RecordSessionMetaFromInbound$1;
type UpdateLastRoute = UpdateLastRoute$1;
type RecordInboundSession = RecordInboundSession$1;
type RuntimeThreadBindingLifecycleRecord = SessionBindingRecord | {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};
type PluginRuntimeChannelContextKey = {
  channelId: string;
  accountId?: string | null;
  capability: string;
};
type PluginRuntimeChannelContextEvent = {
  type: "registered" | "unregistered";
  key: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
  context?: unknown;
};
type PluginRuntimeChannelContextRegistry = {
  register: (params: PluginRuntimeChannelContextKey & {
    context: unknown;
    abortSignal?: AbortSignal;
  }) => {
    dispose: () => void;
  };
  get: <T = unknown>(params: PluginRuntimeChannelContextKey) => T | undefined;
  watch: (params: {
    channelId?: string;
    accountId?: string | null;
    capability?: string;
    onEvent: (event: PluginRuntimeChannelContextEvent) => void;
  }) => () => void;
};
type PluginRuntimeChannel = {
  text: {
    chunkByNewline: typeof chunkByNewline;
    chunkMarkdownText: typeof chunkMarkdownText;
    chunkMarkdownTextWithMode: typeof chunkMarkdownTextWithMode;
    chunkText: typeof chunkText;
    chunkTextWithMode: typeof chunkTextWithMode;
    resolveChunkMode: typeof resolveChunkMode;
    resolveTextChunkLimit: typeof resolveTextChunkLimit;
    hasControlCommand: typeof hasControlCommand;
    resolveMarkdownTableMode: ResolveMarkdownTableMode;
    convertMarkdownTables: typeof convertMarkdownTables;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    createReplyDispatcherWithTyping: CreateReplyDispatcherWithTyping;
    resolveEffectiveMessagesConfig: typeof resolveEffectiveMessagesConfig;
    resolveHumanDelayConfig: typeof resolveHumanDelayConfig;
    dispatchReplyFromConfig: DispatchReplyFromConfig;
    withReplyDispatcher: typeof withReplyDispatcher;
    settleReplyDispatcher: typeof settleReplyDispatcher;
    finalizeInboundContext: typeof finalizeInboundContext;
    formatAgentEnvelope: typeof formatAgentEnvelope; /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
    formatInboundEnvelope: typeof formatInboundEnvelope;
    resolveEnvelopeFormatOptions: typeof resolveEnvelopeFormatOptions;
  };
  routing: {
    buildAgentSessionKey: typeof buildAgentSessionKey;
    resolveAgentRoute: typeof resolveAgentRoute;
  };
  pairing: {
    buildPairingReply: typeof buildPairingReply;
    readAllowFromStore: ReadChannelAllowFromStoreForAccount;
    upsertPairingRequest: UpsertChannelPairingRequestForAccount;
  };
  media: {
    readRemoteMediaBuffer: typeof readRemoteMediaBuffer; /** @deprecated Use `readRemoteMediaBuffer`. */
    fetchRemoteMedia: typeof fetchRemoteMedia;
    saveRemoteMedia: typeof saveRemoteMedia;
    saveResponseMedia: typeof saveResponseMedia;
    saveMediaBuffer: typeof saveMediaBuffer;
  };
  activity: {
    record: typeof recordChannelActivity;
    get: typeof getChannelActivity;
  };
  session: {
    resolveStorePath: typeof resolveStorePath;
    readSessionUpdatedAt: ReadSessionUpdatedAt;
    recordSessionMetaFromInbound: RecordSessionMetaFromInbound;
    recordInboundSession: RecordInboundSession;
    updateLastRoute: UpdateLastRoute;
  };
  mentions: {
    buildMentionRegexes: BuildMentionRegexes;
    matchesMentionPatterns: MatchesMentionPatterns;
    matchesMentionWithExplicit: MatchesMentionWithExplicit;
    implicitMentionKindWhen: typeof implicitMentionKindWhen;
    resolveInboundMentionDecision: typeof resolveInboundMentionDecision;
  };
  reactions: {
    createAckReactionHandle: typeof createAckReactionHandle;
    shouldAckReaction: typeof shouldAckReaction;
    removeAckReactionAfterReply: typeof removeAckReactionAfterReply;
    removeAckReactionHandleAfterReply: typeof removeAckReactionHandleAfterReply;
  };
  groups: {
    resolveGroupPolicy: typeof resolveChannelGroupPolicy;
    resolveRequireMention: typeof resolveChannelGroupRequireMention;
  };
  debounce: {
    createInboundDebouncer: typeof createInboundDebouncer;
    resolveInboundDebounceMs: typeof resolveInboundDebounceMs;
  };
  commands: {
    resolveCommandAuthorizedFromAuthorizers: typeof resolveCommandAuthorizedFromAuthorizers;
    isControlCommandMessage: IsControlCommandMessage;
    shouldComputeCommandAuthorized: ShouldComputeCommandAuthorized;
    shouldHandleTextCommands: ShouldHandleTextCommands;
  };
  outbound: {
    loadAdapter: LoadChannelOutboundAdapter;
  };
  turn: {
    run: typeof runChannelTurn;
    runAssembled: typeof dispatchAssembledChannelTurn; /** @deprecated Prefer `run(...)`. */
    runResolved: typeof runResolvedChannelTurn;
    buildContext: typeof buildChannelTurnContext;
    runPrepared: typeof runPreparedChannelTurn; /** @deprecated Prefer `runAssembled(...)`. */
    dispatchAssembled: typeof dispatchAssembledChannelTurn;
  };
  threadBindings: {
    setIdleTimeoutBySessionKey: (params: {
      channelId: string;
      targetSessionKey: string;
      accountId?: string;
      idleTimeoutMs: number;
    }) => RuntimeThreadBindingLifecycleRecord[];
    setMaxAgeBySessionKey: (params: {
      channelId: string;
      targetSessionKey: string;
      accountId?: string;
      maxAgeMs: number;
    }) => RuntimeThreadBindingLifecycleRecord[];
  };
  runtimeContexts: PluginRuntimeChannelContextRegistry;
};
//#endregion
//#region src/plugins/runtime/types.d.ts
type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  idempotencyKey?: string;
};
type SubagentRunResult = {
  runId: string;
};
type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};
type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};
type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};
type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};
/** @deprecated Use SubagentGetSessionMessagesParams. */
type SubagentGetSessionParams = SubagentGetSessionMessagesParams;
/** @deprecated Use SubagentGetSessionMessagesResult. */
type SubagentGetSessionResult = SubagentGetSessionMessagesResult;
type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};
type RuntimeNodeListParams = {
  connected?: boolean;
};
type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    connected?: boolean;
    caps?: string[];
    commands?: string[];
  }>;
};
type RuntimeNodeInvokeParams = {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
};
/** Trusted in-process runtime surface injected into native plugins. */
type PluginRuntime = PluginRuntimeCore & {
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (params: SubagentGetSessionMessagesParams) => Promise<SubagentGetSessionMessagesResult>; /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
  };
  channel: PluginRuntimeChannel;
};
type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  nodes?: PluginRuntime["nodes"];
  allowGatewaySubagentBinding?: boolean;
};
//#endregion
export { settleReplyDispatcher as a, SubagentRunResult as i, PluginRuntime as n, SubagentRunParams as r, CreatePluginRuntimeOptions as t };