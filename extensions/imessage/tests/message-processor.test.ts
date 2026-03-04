/**
 * Tests for iMessage Reply Processor
 * 
 * Comprehensive test suite covering all reply processing functionality including
 * edge cases, error handling, and integration scenarios.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { 
  IMessageReplyProcessor,
  createIMessageReplyProcessor,
  processIMessageWithReplyContext,
  type IMessageMessage,
  type EnhancedIMessageMessage 
} from '../src/message-processor.js';

// Mock the PluginRuntime
const mockRuntime = {
  shell: {
    exec: vi.fn(),
  },
} as any;

describe('IMessageReplyProcessor', () => {
  let processor: IMessageReplyProcessor;
  let mockExec: MockedFunction<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new IMessageReplyProcessor(mockRuntime);
    mockExec = mockRuntime.shell.exec;
  });

  describe('processMessage', () => {
    it('should return message as-is when no thread_originator_guid', async () => {
      const message: IMessageMessage = {
        id: 1,
        guid: 'test-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Hello world',
        is_from_me: false,
        created_at: '2026-03-04T18:53:59.806Z',
      };

      const result = await processor.processMessage(message);

      expect(result).toEqual(message);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('should enrich message with reply context when thread_originator_guid exists', async () => {
      const replyMessage: IMessageMessage = {
        id: 2,
        guid: 'reply-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'This is a reply',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
        thread_originator_guid: 'original-guid',
      };

      const originalMessage = {
        id: 1,
        guid: 'original-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Original message text',
        is_from_me: false,
        created_at: '2026-03-04T18:53:00.000Z',
      };

      // Mock successful imsg command execution
      mockExec.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify(originalMessage) + '\n',
        stderr: '',
      });

      const result = await processor.processMessage(replyMessage);

      expect(result).toEqual({
        ...replyMessage,
        reply_to: {
          message_id: 'original-guid',
          text: 'Original message text',
          sender: '+1234567890',
          created_at: '2026-03-04T18:53:00.000Z',
          is_from_me: false,
        },
      });

      expect(mockExec).toHaveBeenCalledWith(
        'imsg history --chat-id 6 --limit 100 --json',
        {
          encoding: 'utf8',
          timeout: 10000,
        }
      );
    });

    it('should try extended search when message not found in recent history', async () => {
      const replyMessage: IMessageMessage = {
        id: 2,
        guid: 'reply-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'This is a reply',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
        thread_originator_guid: 'old-guid',
      };

      const oldMessage = {
        id: 1,
        guid: 'old-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Very old message',
        is_from_me: false,
        created_at: '2026-03-01T10:00:00.000Z',
      };

      // First call (recent history) returns empty
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      // Second call (extended search) finds the message
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(oldMessage) + '\n',
        stderr: '',
      });

      const result = await processor.processMessage(replyMessage);

      expect(result.reply_to).toEqual({
        message_id: 'old-guid',
        text: 'Very old message',
        sender: '+1234567890',
        created_at: '2026-03-01T10:00:00.000Z',
        is_from_me: false,
      });

      expect(mockExec).toHaveBeenCalledTimes(2);
      expect(mockExec).toHaveBeenNthCalledWith(2,
        'imsg history --chat-id 6 --limit 500 --json',
        {
          encoding: 'utf8',
          timeout: 30000,
        }
      );
    });

    it('should handle missing original message gracefully', async () => {
      const replyMessage: IMessageMessage = {
        id: 2,
        guid: 'reply-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Reply to deleted message',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
        thread_originator_guid: 'deleted-guid',
      };

      // Both searches return empty
      mockExec.mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await processor.processMessage(replyMessage);

      expect(result).toEqual(replyMessage); // No reply_to added
      expect(consoleSpy).toHaveBeenCalledWith(
        '[iMessage Reply] Could not find original message with GUID: deleted-guid'
      );
      
      consoleSpy.mockRestore();
    });

    it('should handle command execution errors gracefully', async () => {
      const replyMessage: IMessageMessage = {
        id: 2,
        guid: 'reply-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Reply with error',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
        thread_originator_guid: 'error-guid',
      };

      mockExec.mockRejectedValue(new Error('Command failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await processor.processMessage(replyMessage);

      expect(result).toEqual(replyMessage); // Falls back to original message
      expect(consoleSpy).toHaveBeenCalledWith(
        '[iMessage Reply] Error fetching original message:',
        expect.any(Error)
      );
      
      consoleSpy.mockRestore();
    });

    it('should handle multiple messages in history response', async () => {
      const replyMessage: IMessageMessage = {
        id: 3,
        guid: 'reply-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Reply in conversation',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
        thread_originator_guid: 'target-guid',
      };

      const historyResponse = [
        {
          id: 1,
          guid: 'other-guid',
          text: 'Other message',
          sender: '+1234567890',
          is_from_me: true,
          created_at: '2026-03-04T18:50:00.000Z',
        },
        {
          id: 2,
          guid: 'target-guid',
          text: 'Target message',
          sender: '+1234567890',
          is_from_me: false,
          created_at: '2026-03-04T18:52:00.000Z',
        },
      ];

      mockExec.mockResolvedValue({
        exitCode: 0,
        stdout: historyResponse.map(msg => JSON.stringify(msg)).join('\n'),
        stderr: '',
      });

      const result = await processor.processMessage(replyMessage);

      expect(result.reply_to).toEqual({
        message_id: 'target-guid',
        text: 'Target message',
        sender: '+1234567890',
        created_at: '2026-03-04T18:52:00.000Z',
        is_from_me: false,
      });
    });
  });

  describe('Static utility methods', () => {
    describe('formatReplyContext', () => {
      it('should return empty string for message without reply context', () => {
        const message: EnhancedIMessageMessage = {
          id: 1,
          guid: 'test-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Hello',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
        };

        const result = IMessageReplyProcessor.formatReplyContext(message);
        expect(result).toBe('');
      });

      it('should format reply context for user message', () => {
        const message: EnhancedIMessageMessage = {
          id: 2,
          guid: 'reply-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'This is a reply',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
          reply_to: {
            message_id: 'original-guid',
            text: 'Original message from user',
            sender: '+1234567890',
            created_at: '2026-03-04T18:50:00.000Z',
            is_from_me: false,
          },
        };

        const result = IMessageReplyProcessor.formatReplyContext(message);
        
        expect(result).toContain('[Replying to message from +1234567890');
        expect(result).toContain('Original message from user');
      });

      it('should format reply context for assistant message', () => {
        const message: EnhancedIMessageMessage = {
          id: 2,
          guid: 'reply-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Reply to assistant',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
          reply_to: {
            message_id: 'assistant-guid',
            text: 'Assistant response here',
            sender: '+1234567890',
            created_at: '2026-03-04T18:50:00.000Z',
            is_from_me: true,
          },
        };

        const result = IMessageReplyProcessor.formatReplyContext(message);
        
        expect(result).toContain('[Replying to message from You');
        expect(result).toContain('Assistant response here');
      });

      it('should truncate long original messages', () => {
        const longText = 'A'.repeat(250);
        
        const message: EnhancedIMessageMessage = {
          id: 2,
          guid: 'reply-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Reply to long message',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
          reply_to: {
            message_id: 'long-guid',
            text: longText,
            sender: '+1234567890',
            created_at: '2026-03-04T18:50:00.000Z',
            is_from_me: false,
          },
        };

        const result = IMessageReplyProcessor.formatReplyContext(message);
        
        expect(result).toContain('A'.repeat(200) + '...');
        expect(result.length).toBeLessThan(longText.length + 100);
      });
    });

    describe('isReply', () => {
      it('should return true for message with thread_originator_guid', () => {
        const message: IMessageMessage = {
          id: 1,
          guid: 'reply-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Reply',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
          thread_originator_guid: 'original-guid',
        };

        expect(IMessageReplyProcessor.isReply(message)).toBe(true);
      });

      it('should return false for message without thread_originator_guid', () => {
        const message: IMessageMessage = {
          id: 1,
          guid: 'normal-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Normal message',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
        };

        expect(IMessageReplyProcessor.isReply(message)).toBe(false);
      });
    });

    describe('getReplyMetadata', () => {
      it('should return null for message without reply context', () => {
        const message: EnhancedIMessageMessage = {
          id: 1,
          guid: 'normal-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Normal message',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
        };

        expect(IMessageReplyProcessor.getReplyMetadata(message)).toBeNull();
      });

      it('should return metadata for message with reply context', () => {
        const message: EnhancedIMessageMessage = {
          id: 2,
          guid: 'reply-guid',
          chat_id: 6,
          sender: '+1234567890',
          text: 'Reply message',
          is_from_me: false,
          created_at: '2026-03-04T18:55:00.000Z',
          reply_to: {
            message_id: 'original-guid',
            text: 'Original message',
            sender: '+1234567890',
            created_at: '2026-03-04T18:50:00.000Z',
            is_from_me: false,
          },
        };

        const metadata = IMessageReplyProcessor.getReplyMetadata(message);

        expect(metadata).toEqual({
          original_message_id: 'original-guid',
          original_sender: '+1234567890',
          original_timestamp: '2026-03-04T18:50:00.000Z',
          reply_delay_ms: 5 * 60 * 1000, // 5 minutes
          has_context: true,
        });
      });
    });
  });

  describe('Factory functions', () => {
    it('should create processor instance', () => {
      const processor = createIMessageReplyProcessor(mockRuntime);
      expect(processor).toBeInstanceOf(IMessageReplyProcessor);
    });

    it('should process message with utility function', async () => {
      const message: IMessageMessage = {
        id: 1,
        guid: 'test-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Test message',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
      };

      const result = await processIMessageWithReplyContext(mockRuntime, message);
      expect(result).toEqual(message);
    });
  });
});

describe('Integration Tests', () => {
  let processor: IMessageReplyProcessor;
  let mockExec: MockedFunction<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new IMessageReplyProcessor(mockRuntime);
    mockExec = mockRuntime.shell.exec;
  });

  it('should handle real-world reply chain scenario', async () => {
    // Simulate a realistic conversation with multiple replies
    const messages = [
      {
        id: 1,
        guid: 'msg-1',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Hey, can you help me with something?',
        is_from_me: false,
        created_at: '2026-03-04T18:50:00.000Z',
      },
      {
        id: 2,
        guid: 'msg-2',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Sure! What do you need?',
        is_from_me: true,
        created_at: '2026-03-04T18:51:00.000Z',
        thread_originator_guid: 'msg-1',
      },
      {
        id: 3,
        guid: 'msg-3',
        chat_id: 6,
        sender: '+1234567890',
        text: 'I need help with my code',
        is_from_me: false,
        created_at: '2026-03-04T18:52:00.000Z',
        thread_originator_guid: 'msg-2',
      },
    ];

    // Mock the history response with all messages
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: messages.map(msg => JSON.stringify(msg)).join('\n'),
      stderr: '',
    });

    // Process the final reply
    const result = await processor.processMessage(messages[2]);

    expect(result.reply_to).toEqual({
      message_id: 'msg-2',
      text: 'Sure! What do you need?',
      sender: '+1234567890',
      created_at: '2026-03-04T18:51:00.000Z',
      is_from_me: true,
    });
  });
});