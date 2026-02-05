/**
 * Multi-Agent Chat System for OpenClaw
 *
 * Provides Slack-style chat channels where multiple agents can participate,
 * collaborate, and interact with users and external platforms.
 *
 * Features:
 * - Channels: public, private, DM, broadcast
 * - @mentions: @agent:id, @AgentName, @all, @channel
 * - Threads: conversation threading with subscriptions
 * - Presence: online/offline status, typing indicators
 * - Collaboration: war-room, expert-panel, chain-of-thought, consensus, coordinator
 * - External Bindings: Slack, Discord, Telegram sync
 *
 * @example
 * ```typescript
 * import { createChannel, sendMessage, resolveTargetAgents } from '@openclaw/agents/chat';
 *
 * // Create a new channel
 * const channel = await createChannel({
 *   name: 'coding-help',
 *   type: 'public',
 *   createdBy: 'admin',
 *   initialMembers: [
 *     { agentId: 'coder', role: 'member', listeningMode: 'mention-only' },
 *     { agentId: 'reviewer', role: 'member', listeningMode: 'mention-only' },
 *   ],
 * });
 *
 * // Route a message to appropriate agents
 * const routing = resolveTargetAgents({
 *   channelId: channel.id,
 *   message: '@coder help me with this function',
 *   authorId: 'user123',
 *   authorType: 'user',
 *   channel,
 * });
 *
 * // routing.respondingAgents = ['coder']
 * ```
 */

// Types
export type {
  AgentChannelType,
  AgentListeningMode,
  AgentChannelMemberRole,
  AgentChannelMember,
  ExternalBindingPlatform,
  ExternalBindingDirection,
  ExternalBindingSyncOptions,
  ExternalBinding,
  AgentChannel,
  AgentChannelSettings,
  CreateChannelParams,
  UpdateChannelParams,
  ChannelMemberUpdate,
  ChannelPermission,
} from "./types/channels.js";

export type {
  MessageAuthorType,
  MessageContentType,
  MessageContentBlock,
  MessageReaction,
  MessageMention,
  ChannelMessage,
  CreateMessageParams,
  UpdateMessageParams,
  MessageQuery,
  MessageSearchParams,
  MessageSearchResult,
} from "./types/messages.js";

// Channel functions
export {
  generateChannelId,
  hasChannelPermission,
  CHANNEL_PERMISSIONS,
  ROLE_PERMISSIONS,
} from "./types/channels.js";

export { generateMessageId, extractMentions } from "./types/messages.js";

// Database
export type {
  PostgresConfig,
  RedisConfig,
  ChatDbConfig,
  IChatDbClient,
  ITransactionClient,
  ConnectionStatus,
  ConnectionStatusUpdate,
} from "./db/client.js";

export {
  DEFAULT_POSTGRES_CONFIG,
  DEFAULT_REDIS_CONFIG,
  REDIS_KEYS,
  REDIS_TTL,
  setChatDbClient,
  getChatDbClient,
  hasChatDbClient,
  buildInsertQuery,
  buildUpdateQuery,
  toJsonb,
  fromJsonb,
  toTimestamp,
  fromTimestamp,
} from "./db/client.js";

export {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  MIGRATIONS,
  CHECK_SCHEMA_SQL,
  GET_VERSION_SQL,
} from "./db/schema.js";

// Channel Store
export {
  createChannel,
  getChannel,
  updateChannel,
  archiveChannel,
  deleteChannel,
  listChannels,
  addMember,
  removeMember,
  updateMember,
  getMember,
  getMembers,
  getMembersByListeningMode,
  getChannelsForAgent,
  muteAgent,
  unmuteAgent,
  isAgentMuted,
  pinMessage,
  unpinMessage,
} from "./store/channel-store.js";

// Message Store
export {
  createMessage,
  getMessage,
  updateMessage,
  deleteMessage,
  getMessages,
  getRecentMessages,
  getThreadMessages,
  addReaction,
  removeReaction,
  getReactions,
  searchMessages,
  getMessageStats,
  updateReadReceipt,
  getUnreadCount,
  getUnreadCounts,
} from "./store/message-store.js";

// Mention Parsing
export type { MentionType, ParsedMention, MentionParseResult } from "./routing/mention-parser.js";

export {
  parseMentions,
  hasMentions,
  mentionsAgent,
  formatMention,
  extractAgentIds,
  normalizeAgentName,
  matchPatternMentions,
} from "./routing/mention-parser.js";

// Routing
export type { RoutingDecision, RoutingReason, RoutingContext } from "./routing/router.js";

export {
  resolveTargetAgents,
  shouldAgentRespond,
  shouldAgentObserve,
  getResponsePriority,
  filterMessagesForAgent,
} from "./routing/router.js";

// Presence
export type {
  AgentStatus,
  AgentPresence,
  PresenceUpdate,
  PresenceSnapshot,
} from "./presence/manager.js";

export {
  updatePresence,
  getPresence,
  getChannelPresence,
  heartbeat,
  setOffline,
  getOnlineAgents,
  isOnline,
  getPresenceSnapshot,
  cleanupStalePresence,
  subscribeToPresence,
} from "./presence/manager.js";

// Typing
export type { TypingIndicator, TypingState } from "./presence/typing.js";

export {
  startTyping,
  stopTyping,
  getTypingAgents,
  getTypingState,
  isTyping,
  formatTypingText,
  subscribeToTyping,
  onMessageSent,
  refreshTyping,
} from "./presence/typing.js";

// Commands
export type {
  CommandContext,
  CommandResult,
  CommandHandler,
  CommandDefinition,
} from "./commands/registry.js";

export {
  registerCommand,
  getCommand,
  listCommands,
  isCommand,
  parseCommand,
  executeCommand,
  getCommandHelp,
  getAllCommandsHelp,
} from "./commands/registry.js";

// Core commands are auto-registered when imported
import "./commands/core.js";

// Permissions
export type { PermissionCheckResult } from "./permissions.js";

export {
  checkPermission,
  checkAgentAction,
  canSendMessage,
  canCreateThread,
  canDeleteMessage,
  getAgentPermissions,
  checkPermissions,
  hasAnyPermission,
  hasAllPermissions,
  canAccessChannel,
} from "./permissions.js";

// Threads
export type {
  ThreadNotificationLevel,
  ThreadSubscriber,
  AgentChannelThread,
  CreateThreadParams,
} from "./threads/manager.js";

export {
  createThread,
  getThread,
  getThreadByMessage,
  listThreads,
  subscribeToThread,
  unsubscribeFromThread,
  updateSubscription,
  markThreadRead,
  getThreadUnreadCount,
  getUnreadThreads,
  archiveThread,
  unarchiveThread,
  updateThreadTitle,
  getThreadNotificationTargets,
  autoSubscribeOnReply,
} from "./threads/manager.js";

// Collaboration
export type {
  CollaborationMode,
  CollaborationStatus,
  ParticipantRole,
  CollaborationParticipant,
  CollaborationConfig,
  CollaborationSession,
  CollaborationEvent,
  AgentResponse,
  ConsensusVote,
  HandoffRequest,
  ExpertActivation,
  WarRoomConfig,
  ExpertPanelConfig,
  ChainConfig,
  ConsensusConfig,
  CoordinatorConfig,
  RoutingRule,
  CreateSessionParams,
} from "./collaboration/types.js";

export {
  createSession,
  getSession,
  getActiveSession,
  pauseSession,
  resumeSession,
  completeSession,
  cancelSession,
  addParticipant,
  removeParticipant,
  recordContribution,
  getActiveParticipants,
  isParticipant,
  listSessions,
  updateSessionConfig,
  onCollaborationEvent,
  emitRoundStarted,
  emitRoundCompleted,
  emitExpertActivated,
  emitHandoffRequested,
  emitHandoffAccepted,
} from "./collaboration/session-manager.js";

export type { CoordinatorDecision } from "./collaboration/coordinator.js";

export {
  coordinateMessage,
  requestHandoff,
  acceptHandoff,
  getNextInChain,
  checkConsensus,
  aggregateResponses,
} from "./collaboration/coordinator.js";

// External Bindings
export type {
  ExternalPlatform,
  BindingDirection,
  SyncStatus,
  ExternalMessage,
  ExternalAttachment,
  ExternalUser,
  ExternalChannelInfo,
  SyncOptions,
  ChannelBinding,
  BindingEvent,
  CreateBindingParams,
  MessageMapping,
  SlackCredentials,
  DiscordCredentials,
  TelegramCredentials,
  PlatformCredentials,
  IPlatformAdapter,
} from "./bindings/types.js";

export {
  registerAdapter,
  getAdapter,
  createBinding,
  getBinding,
  getBindingsForChannel,
  getBindingsForExternal,
  updateBindingStatus,
  deleteBinding,
  syncInbound,
  syncOutbound,
  syncHistory,
  onBindingEvent,
} from "./bindings/sync-manager.js";

// Events
export type { ChannelEventType, ChannelEvent, EventPayload } from "./events/channel-events.js";

export {
  emitChannelEvent,
  emitGlobalEvent,
  subscribeToChannel,
  subscribeToAllChannels,
  subscribeToAgentEvents,
  sendToAgent,
  emitNewMessage,
  emitMessageEdit,
  emitMessageDelete,
  emitTyping,
  emitPresenceUpdate,
  emitMemberJoin,
  emitMemberLeave,
  emitChannelUpdate,
  emitThreadCreate,
  emitCollaborationEvent,
} from "./events/channel-events.js";

// Agent Integration
export type {
  AgentConfig,
  IncomingMessage,
  MessageContext,
  AgentResponse as AgentMessageResponse,
} from "./agent-integration.js";

export {
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  joinChannel,
  leaveChannel,
  handleIncomingMessage,
  sendAgentMessage,
  setAgentStatus,
  getAgentChannels,
  initializeAgent,
  shutdownAgent,
} from "./agent-integration.js";
