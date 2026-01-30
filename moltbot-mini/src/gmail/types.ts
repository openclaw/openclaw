/**
 * Gmail-related type definitions.
 */

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  date: Date;
  labels: string[];
  isUnread: boolean;
  snippet: string;
}

export interface EmailThread {
  id: string;
  messages: EmailMessage[];
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessageDate: Date;
}

export interface EmailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;  // Message ID to reply to
  threadId?: string;   // Thread ID to reply in
}

export interface EmailSearchResult {
  messages: EmailMessage[];
  nextPageToken?: string;
  totalEstimate: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesTotal: number;
  messagesUnread: number;
}
