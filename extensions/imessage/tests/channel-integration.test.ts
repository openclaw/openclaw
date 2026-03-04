/**
 * Tests for OpenClaw iMessage Channel Integration
 * 
 * Tests the integration layer that connects reply processing with OpenClaw's
 * message pipeline and inbound context generation.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import {
  OpenClawIMessageEnhancer,
  createEnhancedIMessageProcessor,
  type EnhancedInboundContext,
} from '../src/channel-integration.js';
import type { IMessageMessage } from '../src/message-processor.js';

// Mock the message processor
vi.mock('../src/message-processor.js', () => ({
  createIMessageReplyProcessor: vi.fn(() => ({
    processMessage: vi.fn(),
  })),
  IMessageReplyProcessor: {
    formatReplyContext: vi.fn(),
  },
}));

const mockRuntime = {
  shell: {
    exec: vi.fn(),
  },
} as any;

describe('OpenClawIMessageEnhancer', () => {
  let enhancer: OpenClawIMessageEnhancer;
  let mockReplyProcessor: any;

  beforeEach(() => {
    vi.clearAllMocks();
    enhancer = new OpenClawIMessageEnhancer(mockRuntime);
    mockReplyProcessor = enhancer['replyProcessor'];
  });

  describe('processInboundMessage', () => {
    it('should process message without reply context', async () => {
      const message: IMessageMessage = {
        id: 1,
        guid: 'test-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Hello world',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
      };

      mockReplyProcessor.processMessage.mockResolvedValue(message);

      const result = await enhancer.processInboundMessage(message);

      expect(result).toEqual({
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
          name: undefined,
        },
        message: {
          id: 'test-guid',
          text: 'Hello world',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
      });

      expect(result.reply_context).toBeUndefined();
    });

    it('should process message with reply context', async () => {
      const originalMessage: IMessageMessage = {
        id: 1,
        guid: 'original-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Original message',
        is_from_me: true,
        created_at: '2026-03-04T18:50:00.000Z',
      };

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

      const enhancedMessage = {
        ...replyMessage,
        reply_to: {
          message_id: originalMessage.guid,
          text: originalMessage.text,
          sender: originalMessage.sender,
          created_at: originalMessage.created_at,
          is_from_me: originalMessage.is_from_me,
        },
      };

      mockReplyProcessor.processMessage.mockResolvedValue(enhancedMessage);

      const result = await enhancer.processInboundMessage(replyMessage);

      expect(result).toEqual({
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
          name: undefined,
        },
        message: {
          id: 'reply-guid',
          text: 'This is a reply',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
        reply_context: {
          original_message_id: 'original-guid',
          original_text: 'Original message',
          original_sender: '+1234567890',
          original_timestamp: '2026-03-04T18:50:00.000Z',
          is_original_from_assistant: true,
        },
      });
    });

    it('should handle group chat type', async () => {
      const message: IMessageMessage = {
        id: 1,
        guid: 'group-guid',
        chat_id: 5,
        sender: '+1234567890',
        text: 'Group message',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
      };

      mockReplyProcessor.processMessage.mockResolvedValue(message);

      const result = await enhancer.processInboundMessage(message, 'group');

      expect(result.chat_type).toBe('group');
      expect(result.chat_id).toBe('imessage:+1234567890');
    });

    it('should include destination_caller_id as sender name', async () => {
      const message: IMessageMessage = {
        id: 1,
        guid: 'test-guid',
        chat_id: 6,
        sender: '+1234567890',
        text: 'Hello',
        is_from_me: false,
        created_at: '2026-03-04T18:55:00.000Z',
        destination_caller_id: 'john@example.com',
      };

      mockReplyProcessor.processMessage.mockResolvedValue(message);

      const result = await enhancer.processInboundMessage(message);

      expect(result.sender.name).toBe('john@example.com');
    });
  });

  describe('formatContextForAI', () => {
    it('should return plain text for message without reply context', () => {
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'test-guid',
          text: 'Hello world',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
      };

      const result = enhancer.formatContextForAI(context);

      expect(result).toBe('Hello world');
    });

    it('should format message with reply context for user original', () => {
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'reply-guid',
          text: 'This is my response',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
        reply_context: {
          original_message_id: 'original-guid',
          original_text: 'What do you think about this?',
          original_sender: '+1234567890',
          original_timestamp: '2026-03-04T18:50:00.000Z',
          is_original_from_assistant: false,
        },
      };

      const result = enhancer.formatContextForAI(context);

      expect(result).toContain('[Reply to User');
      expect(result).toContain('What do you think about this?');
      expect(result).toContain('This is my response');
    });

    it('should format message with reply context for assistant original', () => {
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'reply-guid',
          text: 'Thanks for the help!',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
        reply_context: {
          original_message_id: 'assistant-guid',
          original_text: 'Here is how you solve that problem...',
          original_sender: '+1234567890',
          original_timestamp: '2026-03-04T18:50:00.000Z',
          is_original_from_assistant: true,
        },
      };

      const result = enhancer.formatContextForAI(context);

      expect(result).toContain('[Reply to Assistant');
      expect(result).toContain('Here is how you solve that problem...');
      expect(result).toContain('Thanks for the help!');
    });

    it('should truncate very long original messages', () => {
      const longText = 'A'.repeat(200);
      
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'reply-guid',
          text: 'Short reply',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
        reply_context: {
          original_message_id: 'long-guid',
          original_text: longText,
          original_sender: '+1234567890',
          original_timestamp: '2026-03-04T18:50:00.000Z',
          is_original_from_assistant: false,
        },
      };

      const result = enhancer.formatContextForAI(context);

      expect(result).toContain('A'.repeat(150) + '...');
      expect(result).not.toContain('A'.repeat(200));
    });
  });

  describe('generateTrustedMetadata', () => {
    it('should generate base metadata without reply context', () => {
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'test-guid',
          text: 'Hello',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
      };

      const result = enhancer.generateTrustedMetadata(context);

      expect(result).toEqual({
        schema: 'openclaw.inbound_meta.v1',
        chat_id: 'imessage:+1234567890',
        channel: 'imessage',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
      });

      expect(result).not.toHaveProperty('reply_to');
    });

    it('should include reply metadata when reply context exists', () => {
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'reply-guid',
          text: 'Reply message',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
        reply_context: {
          original_message_id: 'original-guid',
          original_text: 'Original message',
          original_sender: '+1234567890',
          original_timestamp: '2026-03-04T18:50:00.000Z',
          is_original_from_assistant: true,
        },
      };

      const result = enhancer.generateTrustedMetadata(context);

      expect(result).toEqual({
        schema: 'openclaw.inbound_meta.v1',
        chat_id: 'imessage:+1234567890',
        channel: 'imessage',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'direct',
        reply_to: {
          message_id: 'original-guid',
          sender: '+1234567890',
          timestamp: '2026-03-04T18:50:00.000Z',
          is_from_assistant: true,
        },
      });
    });

    it('should handle group chat metadata', () => {
      const context: EnhancedInboundContext = {
        chat_id: 'imessage:+1234567890',
        provider: 'imessage',
        surface: 'imessage',
        chat_type: 'group',
        sender: {
          id: '+1234567890',
        },
        message: {
          id: 'group-guid',
          text: 'Group message',
          timestamp: '2026-03-04T18:55:00.000Z',
        },
      };

      const result = enhancer.generateTrustedMetadata(context);

      expect(result).toHaveProperty('chat_type', 'group');
    });
  });
});

describe('Factory functions', () => {
  it('should create enhanced processor instance', () => {
    const processor = createEnhancedIMessageProcessor(mockRuntime);
    expect(processor).toBeInstanceOf(OpenClawIMessageEnhancer);
  });
});

describe('End-to-End Integration', () => {
  let enhancer: OpenClawIMessageEnhancer;
  let mockReplyProcessor: any;

  beforeEach(() => {
    vi.clearAllMocks();
    enhancer = new OpenClawIMessageEnhancer(mockRuntime);
    mockReplyProcessor = enhancer['replyProcessor'];
  });

  it('should handle complete reply processing workflow', async () => {
    // Simulate a realistic reply scenario
    const originalMessage = {
      id: 1,
      guid: 'original-guid',
      chat_id: 6,
      sender: '+1234567890',
      text: 'Can you help me debug this code issue?',
      is_from_me: false,
      created_at: '2026-03-04T18:50:00.000Z',
    };

    const replyMessage: IMessageMessage = {
      id: 2,
      guid: 'reply-guid',
      chat_id: 6,
      sender: '+1234567890',
      text: 'Sure! What specific error are you seeing?',
      is_from_me: true,
      created_at: '2026-03-04T18:52:00.000Z',
      thread_originator_guid: 'original-guid',
    };

    const enhancedMessage = {
      ...replyMessage,
      reply_to: {
        message_id: originalMessage.guid,
        text: originalMessage.text,
        sender: originalMessage.sender,
        created_at: originalMessage.created_at,
        is_from_me: originalMessage.is_from_me,
      },
    };

    // Mock the reply processor to return enhanced message
    mockReplyProcessor.processMessage.mockResolvedValue(enhancedMessage);

    // Process through the full pipeline
    const inboundContext = await enhancer.processInboundMessage(replyMessage);
    const aiFormattedText = enhancer.formatContextForAI(inboundContext);
    const trustedMetadata = enhancer.generateTrustedMetadata(inboundContext);

    // Verify the full context is properly constructed
    expect(inboundContext.reply_context).toBeDefined();
    expect(inboundContext.reply_context?.original_text).toBe('Can you help me debug this code issue?');
    expect(inboundContext.reply_context?.is_original_from_assistant).toBe(false);

    // Verify AI formatting includes context
    expect(aiFormattedText).toContain('[Reply to User');
    expect(aiFormattedText).toContain('Can you help me debug this code issue?');
    expect(aiFormattedText).toContain('Sure! What specific error are you seeing?');

    // Verify trusted metadata includes reply information
    expect(trustedMetadata).toHaveProperty('reply_to');
    expect((trustedMetadata as any).reply_to.message_id).toBe('original-guid');
  });

  it('should handle error recovery gracefully', async () => {
    const replyMessage: IMessageMessage = {
      id: 2,
      guid: 'reply-guid',
      chat_id: 6,
      sender: '+1234567890',
      text: 'Reply to missing message',
      is_from_me: false,
      created_at: '2026-03-04T18:55:00.000Z',
      thread_originator_guid: 'missing-guid',
    };

    // Mock processor to return message without reply context (error case)
    mockReplyProcessor.processMessage.mockResolvedValue(replyMessage);

    const inboundContext = await enhancer.processInboundMessage(replyMessage);
    const aiFormattedText = enhancer.formatContextForAI(inboundContext);
    const trustedMetadata = enhancer.generateTrustedMetadata(inboundContext);

    // Should gracefully handle missing context
    expect(inboundContext.reply_context).toBeUndefined();
    expect(aiFormattedText).toBe('Reply to missing message');
    expect(trustedMetadata).not.toHaveProperty('reply_to');
  });
});