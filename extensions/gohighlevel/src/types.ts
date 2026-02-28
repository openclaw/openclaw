/** GHL webhook payload for inbound messages (InboundMessage event). */
export type GHLWebhookPayload = {
  type?: string;
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  messageId?: string;
  body?: string;
  dateAdded?: string;
  messageType?: string;
  direction?: string;
  status?: string;
  contentType?: string;
  attachments?: GHLAttachment[];
  from?: string;
  to?: string;
};

export type GHLAttachment = {
  url?: string;
  contentType?: string;
  fileName?: string;
};

/** GHL Conversations API: send message response. */
export type GHLSendMessageResponse = {
  conversationId?: string;
  messageId?: string;
  message?: string;
  msg?: string;
};

/** GHL contact record. */
export type GHLContact = {
  id?: string;
  contactName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  locationId?: string;
  tags?: string[];
};

/** GHL conversation record. */
export type GHLConversation = {
  id?: string;
  contactId?: string;
  locationId?: string;
  lastMessageBody?: string;
  lastMessageDate?: string;
  type?: string;
  unreadCount?: number;
};
