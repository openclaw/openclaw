/**
 * Agent tools for email operations.
 *
 * Each tool is a function that the AI can call to interact with Gmail.
 * Tools follow the OpenAI function calling format.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import * as gmail from '../gmail/client.js';

/**
 * Tool definitions for OpenAI function calling
 */
export const EMAIL_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_emails',
      description: 'List recent emails from inbox or search with a query. Returns email summaries.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Gmail search query (e.g., "from:john@example.com", "is:unread", "subject:meeting")',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of emails to return (default: 10, max: 50)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_email',
      description: 'Read the full content of a specific email by its ID.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The email message ID to read',
          },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send a new email or reply to an existing email.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of recipient email addresses',
          },
          subject: {
            type: 'string',
            description: 'Email subject line',
          },
          body: {
            type: 'string',
            description: 'Email body text',
          },
          cc: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of CC recipient email addresses',
          },
          replyToMessageId: {
            type: 'string',
            description: 'Message ID to reply to (for threading)',
          },
          threadId: {
            type: 'string',
            description: 'Thread ID to add reply to',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'archive_email',
      description: 'Archive an email (remove from inbox but keep in archive).',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The email message ID to archive',
          },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trash_email',
      description: 'Move an email to trash.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The email message ID to trash',
          },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_read',
      description: 'Mark an email as read.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The email message ID to mark as read',
          },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_unread',
      description: 'Mark an email as unread.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The email message ID to mark as unread',
          },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_unread_count',
      description: 'Get the number of unread emails in the inbox.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

/**
 * Execute a tool call
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case 'list_emails': {
        const query = args.query as string | undefined;
        const maxResults = Math.min((args.maxResults as number) || 10, 50);

        const result = await gmail.listEmails({ query, maxResults });

        if (result.messages.length === 0) {
          return 'No emails found matching your criteria.';
        }

        const summaries = result.messages.map((email, i) => {
          const date = email.date.toLocaleDateString();
          const unread = email.isUnread ? '[UNREAD] ' : '';
          return `${i + 1}. ${unread}From: ${email.from}\n   Subject: ${email.subject}\n   Date: ${date}\n   ID: ${email.id}\n   Preview: ${email.snippet.slice(0, 100)}...`;
        });

        return `Found ${result.messages.length} emails:\n\n${summaries.join('\n\n')}`;
      }

      case 'read_email': {
        const messageId = args.messageId as string;
        const email = await gmail.getEmail(messageId);

        return `From: ${email.from}
To: ${email.to.join(', ')}
${email.cc?.length ? `Cc: ${email.cc.join(', ')}\n` : ''}Subject: ${email.subject}
Date: ${email.date.toLocaleString()}
Status: ${email.isUnread ? 'Unread' : 'Read'}

--- Body ---
${email.body}`;
      }

      case 'send_email': {
        const draft = {
          to: args.to as string[],
          subject: args.subject as string,
          body: args.body as string,
          cc: args.cc as string[] | undefined,
          inReplyTo: args.replyToMessageId as string | undefined,
          threadId: args.threadId as string | undefined,
        };

        const messageId = await gmail.sendEmail(draft);
        return `Email sent successfully. Message ID: ${messageId}`;
      }

      case 'archive_email': {
        const messageId = args.messageId as string;
        await gmail.archiveEmail(messageId);
        return `Email ${messageId} has been archived.`;
      }

      case 'trash_email': {
        const messageId = args.messageId as string;
        await gmail.trashEmail(messageId);
        return `Email ${messageId} has been moved to trash.`;
      }

      case 'mark_read': {
        const messageId = args.messageId as string;
        await gmail.markAsRead(messageId);
        return `Email ${messageId} marked as read.`;
      }

      case 'mark_unread': {
        const messageId = args.messageId as string;
        await gmail.markAsUnread(messageId);
        return `Email ${messageId} marked as unread.`;
      }

      case 'get_unread_count': {
        const count = await gmail.getUnreadCount();
        return `You have ${count} unread emails in your inbox.`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return `Error executing ${name}: ${message}`;
  }
}
