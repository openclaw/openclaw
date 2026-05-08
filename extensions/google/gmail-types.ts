export type GmailLabelId = string;

export type GmailMessageHeader = {
  name: string;
  value: string;
};

export type GmailMessagePartBody = {
  attachmentId?: string;
  data?: string;
  size?: number;
};

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: GmailLabelId[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  raw?: string;
  sizeEstimate?: number;
};

export type GmailThread = {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
  snippet?: string;
};

export type GmailListMessagesResponse = {
  messages?: Array<Pick<GmailMessage, "id" | "threadId">>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailListThreadsResponse = {
  threads?: Array<Pick<GmailThread, "id"> & { snippet?: string; historyId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailDraftMessageInput = {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string | string[];
  threadId?: string;
};

export type GmailEncodedMessageRequest = {
  raw: string;
  threadId?: string;
};

export type GmailDraftCreateRequest = {
  message: GmailEncodedMessageRequest;
};

export type GmailDraft = {
  id: string;
  message?: GmailMessage;
};

export type GmailSentMessage = GmailMessage;

export type GmailSearchParams = {
  query?: string;
  labels?: string[];
  newerThanDays?: number;
  unread?: boolean;
  inInbox?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  hasWords?: string[];
};
