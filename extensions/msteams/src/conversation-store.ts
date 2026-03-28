/**
 * Conversation store for MS Teams proactive messaging.
 *
 * Stores ConversationReference-like objects keyed by conversation ID so we can
 * send proactive messages later (after the webhook turn has completed).
 */

/** Minimal ConversationReference shape for proactive messaging */
export type StoredConversationReference = {
  /** Timestamp when this reference was last seen/updated. */
  lastSeenAt?: string;
  /** Activity ID from the last message */
  activityId?: string;
  /** User who sent the message */
  user?: { id?: string; name?: string; aadObjectId?: string };
  /** Agent/bot that received the message */
  agent?: { id?: string; name?: string; aadObjectId?: string } | null;
  /** @deprecated legacy field (pre-Agents SDK). Prefer `agent`. */
  bot?: { id?: string; name?: string };
  /** Conversation details */
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  /** Team ID for channel messages (when available). */
  teamId?: string;
  /** Channel ID (usually "msteams") */
  channelId?: string;
  /** Service URL for sending messages back */
  serviceUrl?: string;
  /** Locale */
  locale?: string;
  /**
   * Cached Graph API chat ID (format: `19:xxx@thread.tacv2` or `19:xxx@unq.gbl.spaces`).
   * Bot Framework conversation IDs for personal DMs use a different format (`a:1xxx` or
   * `8:orgid:xxx`) that the Graph API does not accept. This field caches the resolved
   * Graph-native chat ID so we don't need to re-query the API on every send.
   */
  graphChatId?: string;
  /** IANA timezone from Teams clientInfo entity (e.g. "America/New_York") */
  timezone?: string;
};

export type MSTeamsConversationStoreEntry = {
  conversationId: string;
  reference: StoredConversationReference;
};

export type MSTeamsConversationStore = {
  upsert: (conversationId: string, reference: StoredConversationReference) => Promise<void>;
  get: (conversationId: string) => Promise<StoredConversationReference | null>;
  list: () => Promise<MSTeamsConversationStoreEntry[]>;
  remove: (conversationId: string) => Promise<boolean>;
  findByUserId: (id: string) => Promise<MSTeamsConversationStoreEntry | null>;
};
