/**
 * Tests for payload sanitization functionality
 * Covers thinking block preservation, surrogate handling, and edge cases
 */

import { sanitizePayload, getSanitizationMetrics, resetSanitizationMetrics, createSanitizer } from '../payloadSanitizer.js';
import { sanitizeSurrogates, hasLoneSurrogates } from '../surrogateSanitizer.js';

describe('PayloadSanitizer', () => {
  beforeEach(() => {
    resetSanitizationMetrics();
  });

  describe('sanitizeSurrogates', () => {
    it('should handle valid strings unchanged', () => {
      const validText = 'Hello world! 👋 emoji test';
      expect(sanitizeSurrogates(validText)).toBe(validText);
    });

    it('should replace lone high surrogates', () => {
      const textWithLoneHighSurrogate = 'Test\uD800end';
      const sanitized = sanitizeSurrogates(textWithLoneHighSurrogate);
      expect(sanitized).toBe('Test\uFFFDend');
    });

    it('should replace lone low surrogates', () => {
      const textWithLoneLowSurrogate = 'Test\uDC00end';
      const sanitized = sanitizeSurrogates(textWithLoneLowSurrogate);
      expect(sanitized).toBe('Test\uFFFDend');
    });

    it('should preserve valid surrogate pairs', () => {
      const validSurrogatePair = 'Test\uD83D\uDE00end'; // 😀 emoji
      expect(sanitizeSurrogates(validSurrogatePair)).toBe(validSurrogatePair);
    });
  });

  describe('thinking block preservation', () => {
    it('should preserve thinking blocks with signatures by default', () => {
      const payload = {
        type: 'thinking',
        signature: 'valid-signature-hash',
        thinking: 'This contains\uD800 a lone surrogate',
        other: 'normal content'
      };

      const result = sanitizePayload(payload);
      
      expect(result.type).toBe('thinking');
      expect(result.signature).toBe('valid-signature-hash');
      expect(result.thinking).toBe('This contains\uD800 a lone surrogate'); // Preserved
    });

    it('should sanitize non-thinking content', () => {
      const payload = {
        type: 'text',
        content: 'This contains\uD800 a lone surrogate'
      };

      const result = sanitizePayload(payload);
      
      expect(result.content).toBe('This contains\uFFFD a lone surrogate');
    });

    it('should handle thinking blocks without signatures', () => {
      const payload = {
        type: 'thinking',
        thinking: 'This contains\uD800 a lone surrogate'
        // No signature
      };

      const result = sanitizePayload(payload);
      
      expect(result.thinking).toBe('This contains\uFFFD a lone surrogate'); // Sanitized
    });
  });

  describe('nested structure handling', () => {
    it('should handle nested arrays with thinking blocks', () => {
      const payload = [
        { type: 'text', content: 'Normal\uD800content' },
        { 
          type: 'thinking', 
          signature: 'sig123',
          thinking: 'Preserved\uD800content' 
        }
      ];

      const result = sanitizePayload(payload);
      
      expect(result[0].content).toBe('Normal\uFFFDcontent');
      expect(result[1].thinking).toBe('Preserved\uD800content');
    });

    it('should handle deeply nested objects', () => {
      const payload = {
        messages: [
          {
            blocks: [
              {
                type: 'thinking',
                signature: 'valid-sig',
                thinking: 'Deep\uD800nested'
              }
            ]
          }
        ],
        meta: {
          description: 'Contains\uD800surrogate'
        }
      };

      const result = sanitizePayload(payload);
      
      expect(result.messages[0].blocks[0].thinking).toBe('Deep\uD800nested'); // Preserved
      expect(result.meta.description).toBe('Contains\uFFFDsurrogate'); // Sanitized
    });
  });

  describe('configuration options', () => {
    it('should respect preserveThinkingBlocks: false', () => {
      const payload = {
        type: 'thinking',
        signature: 'valid-sig',
        thinking: 'Should\uD800be\uD800sanitized'
      };

      const result = sanitizePayload(payload, { preserveThinkingBlocks: false });
      
      expect(result.thinking).toBe('Should\uFFFDbe\uFFFDsanitized');
    });

    it('should collect metrics when enabled', () => {
      const payload = {
        type: 'thinking',
        signature: 'sig',
        thinking: 'preserved'
      };

      sanitizePayload(payload, { enableMetrics: true });
      const metrics = getSanitizationMetrics();
      
      expect(metrics.totalProcessed).toBe(1);
      expect(metrics.thinkingBlocksPreserved).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should handle null/undefined gracefully', () => {
      expect(sanitizePayload(null)).toBe(null);
      expect(sanitizePayload(undefined)).toBe(undefined);
    });

    it('should handle primitive values', () => {
      expect(sanitizePayload(123)).toBe(123);
      expect(sanitizePayload(true)).toBe(true);
      expect(sanitizePayload('string\uD800')).toBe('string\uFFFD');
    });

    it('should return original payload on sanitization errors', () => {
      const circularPayload = {};
      circularPayload.self = circularPayload;
      
      // Should not throw and return something reasonable
      const result = sanitizePayload(circularPayload);
      expect(result).toBeDefined();
    });
  });

  describe('createSanitizer', () => {
    it('should create pre-configured sanitizer', () => {
      const strictSanitizer = createSanitizer({ preserveThinkingBlocks: false });
      
      const payload = {
        type: 'thinking',
        signature: 'sig',
        thinking: 'test\uD800'
      };
      
      const result = strictSanitizer(payload);
      expect(result.thinking).toBe('test\uFFFD'); // Sanitized due to config
    });
  });
});