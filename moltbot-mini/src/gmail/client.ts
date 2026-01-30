/**
 * Gmail API client for email operations.
 *
 * Provides high-level methods for:
 * - Listing emails
 * - Reading email content
 * - Searching emails
 * - Sending emails
 * - Managing labels
 */

import { google, gmail_v1 } from 'googleapis';
import { createOAuth2Client, isAuthenticated } from './auth.js';
import { EmailMessage, EmailDraft, EmailSearchResult, GmailLabel } from './types.js';

/**
 * Get authenticated Gmail API client
 */
function getGmailClient(): gmail_v1.Gmail {
  if (!isAuthenticated()) {
    throw new Error('Gmail not authenticated. Run: moltbot-mini gmail auth');
  }

  const auth = createOAuth2Client();
  if (!auth) {
    throw new Error('Gmail credentials not configured');
  }

  return google.gmail({ version: 'v1', auth });
}

/**
 * Parse email headers
 */
function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const header = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

/**
 * Decode base64url encoded content
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Extract email body from message parts
 */
function extractBody(payload: gmail_v1.Schema$MessagePart): { text: string; html?: string } {
  let text = '';
  let html: string | undefined;

  function processPart(part: gmail_v1.Schema$MessagePart): void {
    if (part.body?.data) {
      const content = decodeBase64Url(part.body.data);
      if (part.mimeType === 'text/plain') {
        text = content;
      } else if (part.mimeType === 'text/html') {
        html = content;
      }
    }
    if (part.parts) {
      part.parts.forEach(processPart);
    }
  }

  processPart(payload);

  // If no text body, try to extract from HTML
  if (!text && html) {
    text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return { text, html };
}

/**
 * Convert Gmail API message to our EmailMessage type
 */
function parseMessage(msg: gmail_v1.Schema$Message): EmailMessage {
  const headers = msg.payload?.headers || [];
  const body = extractBody(msg.payload || {});

  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To').split(',').map((s) => s.trim()).filter(Boolean),
    cc: getHeader(headers, 'Cc').split(',').map((s) => s.trim()).filter(Boolean),
    subject: getHeader(headers, 'Subject'),
    body: body.text,
    bodyHtml: body.html,
    date: new Date(parseInt(msg.internalDate || '0', 10)),
    labels: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    snippet: msg.snippet || '',
  };
}

/**
 * List recent emails
 */
export async function listEmails(options: {
  maxResults?: number;
  labelIds?: string[];
  query?: string;
  pageToken?: string;
}): Promise<EmailSearchResult> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: options.maxResults || 20,
    labelIds: options.labelIds,
    q: options.query,
    pageToken: options.pageToken,
  });

  const messages: EmailMessage[] = [];

  if (response.data.messages) {
    // Fetch full message details for each
    for (const msg of response.data.messages) {
      if (msg.id) {
        const fullMsg = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });
        messages.push(parseMessage(fullMsg.data));
      }
    }
  }

  return {
    messages,
    nextPageToken: response.data.nextPageToken || undefined,
    totalEstimate: response.data.resultSizeEstimate || 0,
  };
}

/**
 * Get a single email by ID
 */
export async function getEmail(messageId: string): Promise<EmailMessage> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  return parseMessage(response.data);
}

/**
 * Search emails
 */
export async function searchEmails(query: string, maxResults = 20): Promise<EmailSearchResult> {
  return listEmails({ query, maxResults });
}

/**
 * Send an email
 */
export async function sendEmail(draft: EmailDraft): Promise<string> {
  const gmail = getGmailClient();

  // Build RFC 2822 formatted email
  const lines: string[] = [];

  lines.push(`To: ${draft.to.join(', ')}`);
  if (draft.cc?.length) {
    lines.push(`Cc: ${draft.cc.join(', ')}`);
  }
  lines.push(`Subject: ${draft.subject}`);
  if (draft.inReplyTo) {
    lines.push(`In-Reply-To: ${draft.inReplyTo}`);
    lines.push(`References: ${draft.inReplyTo}`);
  }
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(draft.body);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: draft.threadId,
    },
  });

  return response.data.id || '';
}

/**
 * Mark email as read
 */
export async function markAsRead(messageId: string): Promise<void> {
  const gmail = getGmailClient();

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });
}

/**
 * Mark email as unread
 */
export async function markAsUnread(messageId: string): Promise<void> {
  const gmail = getGmailClient();

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: ['UNREAD'],
    },
  });
}

/**
 * Archive email (remove from inbox)
 */
export async function archiveEmail(messageId: string): Promise<void> {
  const gmail = getGmailClient();

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['INBOX'],
    },
  });
}

/**
 * Trash email
 */
export async function trashEmail(messageId: string): Promise<void> {
  const gmail = getGmailClient();

  await gmail.users.messages.trash({
    userId: 'me',
    id: messageId,
  });
}

/**
 * List labels
 */
export async function listLabels(): Promise<GmailLabel[]> {
  const gmail = getGmailClient();

  const response = await gmail.users.labels.list({
    userId: 'me',
  });

  return (response.data.labels || []).map((label) => ({
    id: label.id || '',
    name: label.name || '',
    type: label.type === 'system' ? 'system' : 'user',
    messagesTotal: label.messagesTotal || 0,
    messagesUnread: label.messagesUnread || 0,
  }));
}

/**
 * Get user's email address
 */
export async function getEmailAddress(): Promise<string> {
  const gmail = getGmailClient();

  const response = await gmail.users.getProfile({
    userId: 'me',
  });

  return response.data.emailAddress || '';
}

/**
 * Get unread count
 */
export async function getUnreadCount(): Promise<number> {
  const gmail = getGmailClient();

  const response = await gmail.users.labels.get({
    userId: 'me',
    id: 'INBOX',
  });

  return response.data.messagesUnread || 0;
}
