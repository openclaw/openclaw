/**
 * Types for Convos CLI integration
 */

export interface CreateConversationResult {
  conversationId: string;
  inviteSlug: string;
  inviteUrl: string;
}

export interface ConvosSetupResult {
  inviteUrl: string;
  conversationId: string;
  identityId: string;
}

export interface InviteResult {
  inviteSlug: string;
}
