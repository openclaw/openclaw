import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChatType } from "./chat-type-BtX_XjMF.js";
import { S as MarkdownTableMode } from "./types.base-DS--yneR.js";
import { b as MessagePresentation, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { n as InboundEventKind } from "./input-provenance-DgsxhTbk.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { t as OutboundMediaAccess } from "./load-options-CTuppEe4.js";
import { n as PollInput } from "./polls-CfHkU59X.js";
import { n as GatewayClientName, t as GatewayClientMode } from "./client-info-Bg3dBQ8F.js";
import { TSchema } from "typebox";
import { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

//#region src/channels/plugins/message-action-names.d.ts
declare const CHANNEL_MESSAGE_ACTION_NAMES: readonly ["send", "broadcast", "poll", "poll-vote", "react", "reactions", "read", "edit", "unsend", "reply", "sendWithEffect", "renameGroup", "setGroupIcon", "addParticipant", "removeParticipant", "leaveGroup", "sendAttachment", "delete", "pin", "unpin", "list-pins", "permissions", "thread-create", "thread-list", "thread-reply", "search", "sticker", "sticker-search", "member-info", "role-info", "emoji-list", "emoji-upload", "sticker-upload", "role-add", "role-remove", "channel-info", "channel-list", "channel-create", "channel-edit", "channel-delete", "channel-move", "category-create", "category-edit", "category-delete", "topic-create", "topic-edit", "voice-status", "event-list", "event-create", "timeout", "kick", "ban", "set-profile", "set-presence", "set-profile", "download-file", "upload-file"];
type ChannelMessageActionName$1 = (typeof CHANNEL_MESSAGE_ACTION_NAMES)[number];
//#endregion
//#region src/channels/plugins/message-capabilities.d.ts
declare const CHANNEL_MESSAGE_CAPABILITIES: readonly ["presentation", "delivery-pin"];
type ChannelMessageCapability = (typeof CHANNEL_MESSAGE_CAPABILITIES)[number];
//#endregion
//#region src/channels/plugins/types.core.d.ts
type ChannelExposure = {
  configured?: boolean;
  setup?: boolean;
  docs?: boolean;
};
type ChannelOutboundTargetMode = "explicit" | "implicit" | "heartbeat";
/** Agent tool registered by a channel plugin. */
type ChannelAgentTool = AgentTool<TSchema, unknown>;
/** Lazy agent-tool factory used when tool availability depends on config. */
type ChannelAgentToolFactory = (params: {
  cfg?: OpenClawConfig;
}) => ChannelAgentTool[];
/**
 * Discovery-time inputs passed to channel action adapters when the core is
 * asking what an agent should be allowed to see. This is intentionally
 * smaller than execution context: it carries routing/account scope, but no
 * tool params or runtime handles.
 */
type ChannelMessageActionDiscoveryContext = {
  cfg: OpenClawConfig;
  currentChannelId?: string | null;
  currentChannelProvider?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};
/**
 * Plugin-owned schema fragments for the shared `message` tool.
 * `current-channel` means expose the fields only when that provider is the
 * active runtime channel. `all-configured` keeps the fields visible even while
 * another configured channel is active, which is useful for cross-channel
 * sends from cron or isolated agents.
 */
type ChannelMessageToolSchemaContribution = {
  properties: Record<string, TSchema>;
  /**
   * Actions whose validation depends on this schema fragment. Cross-channel
   * discovery can hide only these actions when the fragment is current-channel
   * scoped. Omit to keep the legacy conservative behavior.
   */
  actions?: readonly ChannelMessageActionName[] | null;
  visibility?: "current-channel" | "all-configured";
};
type ChannelMessageToolMediaSourceParams = readonly string[] | Partial<Record<ChannelMessageActionName, readonly string[]>>;
type ChannelMessageToolDiscovery = {
  actions?: readonly ChannelMessageActionName[] | null;
  capabilities?: readonly ChannelMessageCapability[] | null;
  schema?: ChannelMessageToolSchemaContribution | ChannelMessageToolSchemaContribution[] | null;
  /**
   * Plugin-owned message-tool params that carry media sources.
   * Core uses this to derive sandbox path normalization and host media-access
   * hints without hardcoding plugin-specific param names. Prefer scoping keys
   * by action so unrelated actions do not inherit another action's media args.
   */
  mediaSourceParams?: ChannelMessageToolMediaSourceParams | null;
};
/** Shared setup input bag used by CLI, onboarding, and setup adapters. */
type ChannelSetupInput = {
  name?: string;
  token?: string;
  privateKey?: string;
  tokenFile?: string;
  secret?: string;
  secretFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  webhookPath?: string;
  webhookUrl?: string;
  audienceType?: string;
  audience?: string;
  useEnv?: boolean;
  homeserver?: string;
  dangerouslyAllowPrivateNetwork?: boolean; /** @deprecated Compatibility alias; prefer dangerouslyAllowPrivateNetwork. */
  allowPrivateNetwork?: boolean;
  proxy?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  avatarUrl?: string;
  initialSyncLimit?: number;
  ship?: string;
  url?: string;
  baseUrl?: string;
  relayUrls?: string;
  code?: string;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
};
type ChannelStatusIssue = {
  channel: ChannelId;
  accountId: string;
  kind: "intent" | "permissions" | "config" | "auth" | "runtime";
  message: string;
  fix?: string;
};
type ChannelAccountState = "linked" | "not linked" | "configured" | "not configured" | "enabled" | "disabled";
type ChannelHeartbeatDeps = {
  webAuthExists?: () => Promise<boolean>;
  hasActiveWebListener?: (accountId?: string) => boolean;
};
type ChannelLegacyStateMigrationPlan = {
  kind: "copy" | "move";
  label: string;
  sourcePath: string;
  targetPath: string;
};
/** User-facing metadata used in docs, pickers, and setup surfaces. */
type ChannelMeta = {
  id: ChannelId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  order?: number;
  aliases?: readonly string[];
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: readonly string[];
  detailLabel?: string;
  systemImage?: string;
  markdownCapable?: boolean;
  exposure?: ChannelExposure;
  showConfigured?: boolean;
  showInSetup?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
  preferOver?: readonly string[];
};
/** Snapshot row returned by channel status and lifecycle surfaces. */
type ChannelAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  statusState?: string;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  restartPending?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: string | {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastError?: string | null;
  healthState?: string;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  mode?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  tokenSource?: string;
  botTokenSource?: string;
  appTokenSource?: string;
  signingSecretSource?: string;
  tokenStatus?: string;
  botTokenStatus?: string;
  appTokenStatus?: string;
  signingSecretStatus?: string;
  userTokenStatus?: string;
  credentialSource?: string;
  secretSource?: string;
  audienceType?: string;
  audience?: string;
  webhookPath?: string;
  webhookUrl?: string;
  baseUrl?: string;
  allowUnmentionedGroups?: boolean;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  audit?: unknown;
  application?: unknown;
  bot?: unknown;
  publicKey?: string | null;
  profile?: unknown;
  channelAccessToken?: string;
  channelSecret?: string;
};
type ChannelLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};
type ChannelGroupContext = {
  cfg: OpenClawConfig;
  groupId?: string | null; /** Human label for channel-like group conversations (e.g. #general). */
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};
/** TTS voice delivery behavior advertised by a channel plugin. */
/**
 * Container tokens (file-extension shape, no leading dot) that the host
 * speech-core pipeline knows how to pre-transcode synthesized audio into.
 * Channels that benefit from a specific container — currently only
 * iMessage, which needs Apple's native voice-memo CAF descriptor — name
 * one here. Adding a new entry requires extending the host transcoder
 * recipe table in lockstep so a typed declaration cannot silently no-op.
 */
type PreferredAudioFileFormat = "caf";
type ChannelTtsVoiceDeliveryCapabilities = {
  synthesisTarget: "audio-file" | "voice-note";
  transcodesAudio?: boolean;
  audioFileFormats?: readonly string[];
  /**
   * Optional preferred audio container the channel wants for voice-memo
   * delivery. When set and the host can transcode (e.g. `afconvert` on
   * macOS), the TTS pipeline pre-encodes synthesized audio to this format
   * before handing it to the channel. Useful for channels (such as
   * iMessage) whose downstream attempts its own container conversion
   * that races against the upload write and fails.
   */
  preferAudioFileFormat?: PreferredAudioFileFormat;
};
/** Static capability flags advertised by a channel plugin. */
type ChannelCapabilities = {
  chatTypes: Array<ChatType | "thread">;
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  effects?: boolean;
  groupManagement?: boolean;
  threads?: boolean;
  media?: boolean;
  tts?: {
    voice?: ChannelTtsVoiceDeliveryCapabilities;
  };
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};
type ChannelSecurityDmPolicy = {
  policy: string;
  allowFrom?: Array<string | number> | null;
  policyPath?: string;
  allowFromPath: string;
  approveHint: string;
  normalizeEntry?: (raw: string) => string;
};
type ChannelSecurityContext<ResolvedAccount = unknown> = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedAccount;
};
type ChannelMentionAdapter = {
  stripRegexes?: (params: {
    ctx: MsgContext;
    cfg: OpenClawConfig | undefined;
    agentId?: string;
  }) => RegExp[];
  stripPatterns?: (params: {
    ctx: MsgContext;
    cfg: OpenClawConfig | undefined;
    agentId?: string;
  }) => string[];
  stripMentions?: (params: {
    text: string;
    ctx: MsgContext;
    cfg: OpenClawConfig | undefined;
    agentId?: string;
  }) => string;
};
type ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults?: {
    minChars: number;
    idleMs: number;
  };
};
type ChannelStructuredComponents = unknown[];
type ChannelCrossContextPresentationFactory = (params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => MessagePresentation;
type ChannelReplyTransport = {
  replyToId?: string | null;
  threadId?: string | number | null;
};
type ChannelFocusedBindingContext = {
  conversationId: string;
  parentConversationId?: string;
  placement: "current" | "child";
  labelNoun: string;
};
type ChannelOutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: {
    kind: ChatType;
    id: string;
  };
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};
type ChannelThreadingAdapter = {
  resolveReplyToMode?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    chatType?: string | null;
  }) => "off" | "first" | "all" | "batched";
  /**
   * When replyToMode is "off", allow explicit reply tags/directives to keep replyToId.
   *
   * Default in shared reply flow: true for known providers; per-channel opt-out supported.
   */
  allowExplicitReplyTagsWhenOff?: boolean;
  /**
   * @deprecated Use allowExplicitReplyTagsWhenOff.
   *
   * Deprecated alias for allowExplicitReplyTagsWhenOff.
   * Kept for compatibility with older plugin surfaces.
   */
  allowTagsWhenOff?: boolean;
  buildToolContext?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: {
      value: boolean;
    };
  }) => ChannelThreadingToolContext | undefined;
  resolveAutoThreadId?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    to: string;
    toolContext?: ChannelThreadingToolContext;
    replyToId?: string | null;
  }) => string | undefined;
  resolveCurrentChannelId?: (params: {
    to: string;
    threadId?: string | number | null;
  }) => string | undefined;
  resolveReplyTransport?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string | null;
  }) => ChannelReplyTransport | null;
  resolveFocusedBinding?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
  }) => ChannelFocusedBindingContext | null;
};
type ChannelThreadingContext = {
  Channel?: string;
  From?: string;
  To?: string;
  ChatType?: string;
  CurrentMessageId?: string | number;
  ReplyToId?: string;
  ReplyToIdFull?: string;
  ThreadLabel?: string;
  MessageThreadId?: string | number;
  TransportThreadId?: string | number; /** Platform-native channel/conversation id (e.g. Slack DM channel "D…" id). */
  NativeChannelId?: string;
};
type ChannelThreadingToolContext = {
  currentChannelId?: string;
  currentGraphChannelId?: string;
  currentChannelProvider?: ChannelId;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: {
    value: boolean;
  }; /** True when posting at the parent conversation root would leak a thread-originated reply. */
  sameChannelThreadRequired?: boolean;
  /**
   * When true, skip cross-context decoration (e.g., "[from X]" prefix).
   * Use this for direct tool invocations where the agent is composing a new message,
   * not forwarding/relaying a message from another conversation.
   */
  skipCrossContextDecoration?: boolean;
};
/** Channel-owned messaging helpers for target parsing, routing, and payload shaping. */
type ChannelMessagingAdapter = {
  /**
   * Provider prefixes accepted in explicit targets, including aliases not used
   * as channel-selection aliases. Core uses these to reject cross-channel
   * targets before plugin-specific normalization.
   */
  targetPrefixes?: readonly string[];
  normalizeTarget?: (raw: string) => string | undefined;
  defaultMarkdownTableMode?: MarkdownTableMode;
  normalizeExplicitSessionKey?: (params: {
    sessionKey: string;
    ctx: MsgContext;
  }) => string | undefined;
  deriveLegacySessionChatType?: (sessionKey: string) => "direct" | "group" | "channel" | undefined;
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
  resolveLegacyGroupSessionKey?: (ctx: MsgContext) => {
    key: string;
    channel: string;
    id: string;
    chatType: "group" | "channel";
  } | null;
  resolveInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  resolveRemoteInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  /**
   * Bundled plugins that need inbound conversation resolution before runtime
   * bootstrap can mirror it through a top-level `thread-binding-api.ts` surface.
   */
  resolveInboundConversation?: (params: {
    from?: string;
    to?: string;
    conversationId?: string;
    threadId?: string | number;
    isGroup: boolean;
  }) => {
    conversationId?: string;
    parentConversationId?: string;
  } | null;
  resolveDeliveryTarget?: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => {
    to?: string;
    threadId?: string;
  } | null;
  /**
   * Canonical plugin-owned session conversation grammar.
   * Use this when the provider encodes thread or scoped-conversation semantics
   * inside `rawId` (for example Telegram topics or Feishu sender scopes).
   * Return `baseConversationId` and `parentConversationCandidates` here when
   * you can so parsing and inheritance stay in one place.
   * `parentConversationCandidates`, when present, should be ordered from the
   * narrowest parent to the broadest/base conversation.
   * Bundled plugins that need the same grammar before runtime bootstrap can
   * mirror this contract through a top-level `session-key-api.ts` surface.
   */
  resolveSessionConversation?: (params: {
    kind: "group" | "channel";
    rawId: string;
  }) => {
    id: string;
    threadId?: string | null;
    baseConversationId?: string | null;
    parentConversationCandidates?: string[];
  } | null;
  /**
   * @deprecated Return parentConversationCandidates from resolveSessionConversation.
   *
   * Legacy compatibility hook for parent fallbacks when a plugin does not need
   * to customize `id` or `threadId`. Core only uses this when
   * `resolveSessionConversation(...)` does not return
   * `parentConversationCandidates`.
   */
  resolveParentConversationCandidates?: (params: {
    kind: "group" | "channel";
    rawId: string;
  }) => string[] | null;
  resolveSessionTarget?: (params: {
    kind: "group" | "channel";
    id: string;
    threadId?: string | null;
  }) => string | undefined;
  parseExplicitTarget?: (params: {
    raw: string;
  }) => {
    to: string;
    threadId?: string | number;
    chatType?: ChatType;
  } | null;
  /**
   * Lightweight chat-type inference used before directory lookup so plugins can
   * steer peer-vs-group resolution without reimplementing host search flow.
   */
  inferTargetChatType?: (params: {
    to: string;
  }) => ChatType | undefined;
  /**
   * Preserve the session thread/topic id for heartbeat replies when that thread
   * is part of the destination identity, not a transient reply thread.
   */
  preserveHeartbeatThreadIdForGroupRoute?: boolean;
  buildCrossContextPresentation?: ChannelCrossContextPresentationFactory;
  transformReplyPayload?: (params: {
    payload: ReplyPayload;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ReplyPayload | null;
  enableInteractiveReplies?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => boolean;
  hasStructuredReplyPayload?: (params: {
    payload: ReplyPayload;
  }) => boolean;
  targetResolver?: {
    looksLikeId?: (raw: string, normalized?: string) => boolean;
    hint?: string;
    /**
     * Plugin-owned fallback for explicit/native targets or post-directory-miss
     * resolution. This should complement directory lookup, not duplicate it.
     */
    resolveTarget?: (params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      input: string;
      normalized: string;
      preferredKind?: ChannelDirectoryEntryKind | "channel";
    }) => Promise<{
      to: string;
      kind: ChannelDirectoryEntryKind | "channel";
      display?: string;
      source?: "normalized" | "directory";
    } | null>;
  };
  formatTargetDisplay?: (params: {
    target: string;
    display?: string;
    kind?: ChannelDirectoryEntryKind;
  }) => string;
  /**
   * Provider-specific session-route builder used after target resolution.
   * Keep session-key orchestration in core and channel-native routing rules here.
   */
  resolveOutboundSessionRoute?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    accountId?: string | null;
    target: string;
    currentSessionKey?: string;
    resolvedTarget?: {
      to: string;
      kind: ChannelDirectoryEntryKind | "channel";
      display?: string;
      source: "normalized" | "directory";
    };
    replyToId?: string | null;
    threadId?: string | number | null;
  }) => ChannelOutboundSessionRoute | Promise<ChannelOutboundSessionRoute | null> | null;
};
type ChannelAgentPromptAdapter = {
  messageToolHints?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  messageToolCapabilities?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[] | undefined;
  inboundFormattingHints?: (params: {
    accountId?: string | null;
  }) => {
    text_markup: string;
    rules: string[];
  } | undefined;
  reactionGuidance?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    level: "minimal" | "extensive";
    channelLabel?: string;
  } | undefined;
};
type ChannelDirectoryEntryKind = "user" | "group" | "channel";
type ChannelDirectoryEntry = {
  kind: ChannelDirectoryEntryKind;
  id: string;
  name?: string;
  handle?: string;
  avatarUrl?: string;
  rank?: number;
  raw?: unknown;
};
type ChannelMessageActionName = ChannelMessageActionName$1;
/** Execution context passed to channel-owned actions on the shared `message` tool. */
type ChannelMessageActionContext = {
  channel: ChannelId;
  action: ChannelMessageActionName;
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string | null;
  /**
   * Trusted sender id from inbound context. This is server-injected and must
   * never be sourced from tool/model-controlled params.
   */
  requesterSenderId?: string | null; /** Trusted owner identity bit from command/channel-action auth. */
  senderIsOwner?: boolean;
  sessionKey?: string | null;
  sessionId?: string | null;
  inboundEventKind?: InboundEventKind;
  agentId?: string | null;
  gateway?: {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName: GatewayClientName;
    clientDisplayName?: string;
    mode: GatewayClientMode;
  };
  toolContext?: ChannelThreadingToolContext;
  dryRun?: boolean;
  gatewayClientScopes?: readonly string[];
};
type ChannelToolSend = {
  to: string;
  accountId?: string | null;
  threadId?: string | null;
};
type ChannelMessagePreparedSendPayloadContext = {
  ctx: ChannelMessageActionContext;
  to: string;
  payload: ReplyPayload;
  replyToId?: string | null;
  threadId?: string | number | null;
};
/** Channel-owned action surface for the shared `message` tool. */
type ChannelMessageActionAdapter = {
  /**
   * Unified discovery surface for the shared `message` tool.
   * This returns the scoped actions,
   * capabilities, schema fragments, and any plugin-owned media-source params
   * together so they cannot drift.
   */
  describeMessageTool: (params: ChannelMessageActionDiscoveryContext) => ChannelMessageToolDiscovery | null | undefined;
  supportsAction?: (params: {
    action: ChannelMessageActionName;
  }) => boolean;
  resolveExecutionMode?: (params: {
    action: ChannelMessageActionName;
  }) => "local" | "gateway";
  resolveCliActionRequest?: (params: {
    action: ChannelMessageActionName;
    args: Record<string, unknown>;
  }) => {
    action: ChannelMessageActionName;
    args: Record<string, unknown>;
  };
  messageActionTargetAliases?: Partial<Record<ChannelMessageActionName, {
    aliases: string[];
  }>>;
  requiresTrustedRequesterSender?: (params: {
    action: ChannelMessageActionName;
    toolContext?: ChannelThreadingToolContext;
  }) => boolean;
  extractToolSend?: (params: {
    args: Record<string, unknown>;
  }) => ChannelToolSend | null;
  /**
   * Translate generic `message(action=send)` arguments into the payload core
   * should persist, retry, recover, and ack. Return null to keep the legacy
   * plugin-owned action path for sends that cannot be represented durably.
   */
  prepareSendPayload?: (params: ChannelMessagePreparedSendPayloadContext) => ReplyPayload | null | undefined | Promise<ReplyPayload | null | undefined>;
  /**
   * Prefer this for channel-specific poll semantics or extra poll parameters.
   * Core only parses the shared poll model when falling back to `outbound.sendPoll`.
   */
  handleAction?: (ctx: ChannelMessageActionContext) => Promise<AgentToolResult<unknown>>;
};
type ChannelPollResult = {
  messageId: string;
  toJid?: string;
  channelId?: string;
  conversationId?: string;
  pollId?: string;
};
/** Shared poll input after core has normalized the common poll model. */
type ChannelPollContext = {
  cfg: OpenClawConfig;
  to: string;
  poll: PollInput;
  accountId?: string | null;
  threadId?: string | null;
  silent?: boolean;
  isAnonymous?: boolean;
  gatewayClientScopes?: readonly string[];
};
/** Minimal base for all channel probe results. Channel-specific probes extend this. */
type BaseProbeResult<TError = string | null> = {
  ok: boolean;
  error?: TError;
};
/** Minimal base for token resolution results. */
type BaseTokenResolution = {
  token: string;
  source: string;
};
//#endregion
export { ChannelPollResult as A, ChannelThreadingToolContext as B, ChannelMessageToolDiscovery as C, ChannelOutboundSessionRoute as D, ChannelMeta as E, ChannelStatusIssue as F, CHANNEL_MESSAGE_ACTION_NAMES as G, ChannelTtsVoiceDeliveryCapabilities as H, ChannelStreamingAdapter as I, ChannelMessageActionName$1 as K, ChannelStructuredComponents as L, ChannelSecurityContext as M, ChannelSecurityDmPolicy as N, ChannelOutboundTargetMode as O, ChannelSetupInput as P, ChannelThreadingAdapter as R, ChannelMessagePreparedSendPayloadContext as S, ChannelMessagingAdapter as T, PreferredAudioFileFormat as U, ChannelToolSend as V, ChannelMessageCapability as W, ChannelLogSink as _, ChannelAgentPromptAdapter as a, ChannelMessageActionContext as b, ChannelCapabilities as c, ChannelDirectoryEntryKind as d, ChannelExposure as f, ChannelLegacyStateMigrationPlan as g, ChannelHeartbeatDeps as h, ChannelAccountState as i, ChannelReplyTransport as j, ChannelPollContext as k, ChannelCrossContextPresentationFactory as l, ChannelGroupContext as m, BaseTokenResolution as n, ChannelAgentTool as o, ChannelFocusedBindingContext as p, ChannelAccountSnapshot as r, ChannelAgentToolFactory as s, BaseProbeResult as t, ChannelDirectoryEntry as u, ChannelMentionAdapter as v, ChannelMessageToolSchemaContribution as w, ChannelMessageActionDiscoveryContext as x, ChannelMessageActionAdapter as y, ChannelThreadingContext as z };