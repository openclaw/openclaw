export type ArchiveIndexEntry = {
  archiveKey: string;
  conversationId: string;
  messageFile: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
};

export type ArchiveIndex = {
  version: 1;
  archives: Record<string, ArchiveIndexEntry>;
};

export type ArchiveAttachmentRecord = {
  attachmentId: string;
  name: string;
  mime?: string;
  size: number;
  sha256: string;
  storedPath: string;
  sourcePath: string;
  missing?: boolean;
};

export type ArchiveSenderRecord = {
  id?: string;
  name?: string;
};

export type ArchiveMessageRecord = {
  provider: "msteams";
  archiveKey: string;
  conversationId: string;
  conversationType?: string;
  tenantId?: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  threadId?: string;
  threadRootMessageId?: string;
  messageId?: string;
  replyToId?: string;
  timestamp: number;
  sender: ArchiveSenderRecord;
  text: string;
  rawBody: string;
  attachments: ArchiveAttachmentRecord[];
  origin: {
    surface: "msteams";
    chatType?: string;
  };
};

export type ArchiveInboundMessageInput = {
  conversationId: string;
  messageId?: string;
  replyToId?: string;
  threadId?: string;
  timestamp: number;
  content: string;
  rawBody: string;
  chatType?: string;
  conversationType?: string;
  tenantId?: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  senderId?: string;
  senderName?: string;
  mediaPaths: string[];
  mediaTypes: string[];
};

export type ArchiveSearchParams = {
  conversationId?: string;
  query?: string;
  threadId?: string;
  senderId?: string;
  since?: number;
  until?: number;
  hasAttachments?: boolean;
  limit?: number;
};

export type AttachmentSearchParams = {
  conversationId?: string;
  query?: string;
  mime?: string;
  since?: number;
  limit?: number;
};

export type ArchiveChannelEntry = ArchiveIndexEntry & {
  conversationType?: string;
  tenantId?: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
};

export type ArchivePruneResult = {
  removed: boolean;
  conversationId: string;
  removedMessages: number;
  removedAttachments: number;
};
