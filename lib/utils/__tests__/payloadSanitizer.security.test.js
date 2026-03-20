/**
 * Security tests for payload sanitization
 * Addresses GPT-5.2's security validation concerns
 */

import { sanitizePayload, sanitizeSurrogates } from '../payloadSanitizer.js';
import { hasLoneSurrogates } from '../surrogateSanitizer.js';

describe('PayloadSanitizer Security', () => {
  
  describe('Unicode Security', () => {
    test('should handle all types of lone surrogates', () => {
      const testCases = [
        // Lone high surrogates
        'Test\uD800end',
        'Test\uD801end', 
        'Test\uDBFFend', // Last high surrogate
        
        // Lone low surrogates  
        'Test\uDC00end',
        'Test\uDC01end',
        'Test\uDFFFend', // Last low surrogate
        
        // Mixed lone surrogates
        'Test\uD800\uD801end',
        'Test\uDC00\uDC01end',
        
        // Boundary conditions
        '\uD800', // Only lone surrogate
        '\uDC00', // Only lone surrogate
        '\uD800\uDC00\uD801', // Valid pair + lone
      ];
      
      testCases.forEach(testCase => {
        const sanitized = sanitizeSurrogates(testCase);
        expect(hasLoneSurrogates(sanitized)).toBe(false);
        expect(sanitized).not.toContain('\uD800');
        expect(sanitized).not.toContain('\uDC00');
      });
    });

    test('should preserve valid unicode sequences', () => {
      const validSequences = [
        '👋🌍', // Emojis
        'Hello 世界', // Mixed scripts
        'Test\uD83D\uDE00end', // Valid surrogate pair (😀)
        '𝕋𝕖𝕤𝕥', // Mathematical symbols  
        '🚀⚡🎯', // Multiple emojis
      ];
      
      validSequences.forEach(seq => {
        const sanitized = sanitizeSurrogates(seq);
        expect(sanitized).toBe(seq); // Should remain unchanged
      });
    });

    test('should handle ReDoS attack vectors', () => {
      // Create potentially problematic input that could cause ReDoS
      const problematicInput = '\uD800'.repeat(10000) + 'end';
      
      const start = performance.now();
      const sanitized = sanitizeSurrogates(problematicInput);
      const duration = performance.now() - start;
      
      // Should complete within reasonable time (no exponential backtracking)
      expect(duration).toBeLessThan(100); // 100ms threshold
      expect(hasLoneSurrogates(sanitized)).toBe(false);
    });
  });

  describe('Injection Protection', () => {
    test('should handle prototype pollution attempts', () => {
      const maliciousPayload = {
        '__proto__': {
          type: 'thinking',
          signature: 'malicious'
        },
        'constructor': {
          prototype: {
            malicious: true
          }
        },
        content: 'normal\uD800content'
      };
      
      const sanitized = sanitizePayload(maliciousPayload);
      
      // Should not modify prototype chain
      expect(({}).malicious).toBeUndefined();
      expect(sanitized.content).toBe('normal\uFFFDcontent');
    });

    test('should handle circular references safely', () => {
      const circularPayload = {
        content: 'test\uD800content'
      };
      circularPayload.self = circularPayload;
      
      // Should not throw and return reasonable result
      expect(() => {
        const result = sanitizePayload(circularPayload);
        expect(result).toBeDefined();
      }).not.toThrow();
    });

    test('should handle very deep object nesting', () => {
      let deepPayload = { content: 'deep\uD800test' };
      
      // Create 10000 levels deep object
      for (let i = 0; i < 10000; i++) {
        deepPayload = { level: i, nested: deepPayload };
      }
      
      // Should not cause stack overflow
      expect(() => {
        const result = sanitizePayload(deepPayload);
        expect(result).toBeDefined();
      }).not.toThrow();
    });
  });

  describe('Data Integrity', () => {
    test('should not leak original data references', () => {
      const original = {
        sensitive: {
          type: 'thinking',  
          signature: 'valid',
          thinking: 'sensitive data'
        },
        normal: 'test\uD800content'
      };
      
      const sanitized = sanitizePayload(original);
      
      // Modifying sanitized should not affect original
      if (sanitized.sensitive) {
        sanitized.sensitive.thinking = 'modified';
      }
      sanitized.normal = 'modified';
      
      expect(original.sensitive.thinking).toBe('sensitive data');
      expect(original.normal).toBe('test\uD800content');
    });

    test('should handle null bytes and control characters', () => {
      const problematicContent = 'test\0null\x01control\uD800surrogate';
      const payload = { content: problematicContent };
      
      const sanitized = sanitizePayload(payload);
      
      // Should sanitize surrogates but preserve null bytes (application decision)
      expect(sanitized.content).toContain('\0');
      expect(sanitized.content).toContain('\x01');
      expect(sanitized.content).not.toContain('\uD800');
    });

    test('should maintain object property order', () => {
      const orderedPayload = {
        first: 'value1\uD800',
        second: 'value2\uD800',
        third: 'value3\uD800'
      };
      
      const sanitized = sanitizePayload(orderedPayload);
      const originalKeys = Object.keys(orderedPayload);
      const sanitizedKeys = Object.keys(sanitized);
      
      expect(sanitizedKeys).toEqual(originalKeys);
    });
  });

  describe('Error Boundary Testing', () => {
    test('should handle malformed input gracefully', () => {
      const malformedInputs = [
        undefined,
        null,
        Symbol('test'),
        new Error('test error'),
        new Date(),
        /regex/,
        function() { return 'test\uD800'; }
      ];
      
      malformedInputs.forEach(input => {
        expect(() => {
          const result = sanitizePayload(input);
          // Should return something reasonable or original
          expect(result).toBeDefined();
        }).not.toThrow();
      });
    });

    test('should handle extremely large arrays', () => {
      const largeArray = new Array(100000).fill('item\uD800');
      const payload = { items: largeArray };
      
      const start = performance.now();
      const sanitized = sanitizePayload(payload);
      const duration = performance.now() - start;
      
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
      expect(sanitized.items.length).toBe(100000);
      expect(sanitized.items[0]).toBe('item\uFFFD');
    });
  });
});