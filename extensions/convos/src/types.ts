/**
 * Types for Convos SDK client
 */

export interface ConversationInfo {
  id: string;
  displayName: string;
  memberCount: number;
  isUnread: boolean;
  isPinned: boolean;
  isMuted: boolean;
  kind: string;
  createdAt: string;
  lastMessagePreview?: string;
}

export interface MessageInfo {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
}

export interface CreateConversationResult {
  conversationId: string;
  inviteSlug: string;
  inviteUrl: string;
}

export interface ConvosSetupResult {
  inviteUrl: string;
  conversationId: string;
  privateKey: string;
}

export interface JoinConversationResult {
  status: "joined" | "waiting_for_acceptance";
  conversationId: string | null;
}

export interface InviteResult {
  inviteSlug: string;
}

export interface AccountInfo {
  conversationCount: number;
  environment: string;
}
