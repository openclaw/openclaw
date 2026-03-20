/**
 * Performance benchmarks for payload sanitization
 * Addresses Grok-4's concern about large payload handling
 */

import { sanitizePayload, resetSanitizationMetrics } from '../payloadSanitizer.js';
import { performance } from 'perf_hooks';

describe('PayloadSanitizer Performance', () => {
  beforeEach(() => {
    resetSanitizationMetrics();
  });

  // Helper to create large payloads
  function createLargePayload(sizeInKB) {
    const baseString = 'a'.repeat(1024); // 1KB string
    const payload = {
      messages: [],
      metadata: {
        description: 'Large payload test\uD800surrogate'
      }
    };
    
    for (let i = 0; i < sizeInKB; i++) {
      payload.messages.push({
        type: 'text',
        content: baseString + `_${i}`,
        thinking: i % 10 === 0 ? {
          type: 'thinking',
          signature: `sig_${i}`,
          thinking: baseString
        } : undefined
      });
    }
    
    return payload;
  }

  function benchmarkSanitization(payload, label) {
    const start = performance.now();
    const result = sanitizePayload(payload);
    const end = performance.now();
    const duration = end - start;
    
    console.log(`[BENCHMARK] ${label}: ${duration.toFixed(2)}ms`);
    return { result, duration };
  }

  test('should handle 1MB payload within performance threshold', () => {
    const payload = createLargePayload(1024); // ~1MB
    const { duration } = benchmarkSanitization(payload, '1MB payload');
    
    // Should complete within 100ms for 1MB payload
    expect(duration).toBeLessThan(100);
  });

  test('should handle 5MB payload within reasonable time', () => {
    const payload = createLargePayload(5 * 1024); // ~5MB
    const { duration } = benchmarkSanitization(payload, '5MB payload');
    
    // Should complete within 500ms for 5MB payload
    expect(duration).toBeLessThan(500);
  });

  test('should scale linearly with payload size', () => {
    const sizes = [100, 200, 400]; // KB
    const durations = sizes.map(size => {
      const payload = createLargePayload(size);
      const { duration } = benchmarkSanitization(payload, `${size}KB payload`);
      return duration;
    });
    
    // Should scale roughly linearly (allowing 2x tolerance for variance)
    const ratio1 = durations[1] / durations[0];
    const ratio2 = durations[2] / durations[1];
    
    expect(ratio1).toBeLessThan(3); // Should not be more than 3x slower
    expect(ratio2).toBeLessThan(3);
  });

  test('should handle deep nesting efficiently', () => {
    function createDeepPayload(depth) {
      let payload = { content: 'deep\uD800content' };
      
      for (let i = 0; i < depth; i++) {
        payload = {
          nested: payload,
          level: i,
          thinking: i % 5 === 0 ? {
            type: 'thinking',
            signature: `deep_${i}`,
            thinking: 'deep thinking'
          } : undefined
        };
      }
      
      return payload;
    }
    
    const payload = createDeepPayload(1000); // 1000 levels deep
    const { duration } = benchmarkSanitization(payload, 'Deep nesting (1000 levels)');
    
    // Should handle deep nesting within 50ms
    expect(duration).toBeLessThan(50);
  });

  test('should optimize thinking block detection', () => {
    const payloadWithManyThinkingBlocks = {
      messages: Array.from({ length: 1000 }, (_, i) => ({
        type: 'thinking',
        signature: `sig_${i}`,
        thinking: `Thinking block ${i} with\uD800surrogate`
      }))
    };
    
    const { duration } = benchmarkSanitization(
      payloadWithManyThinkingBlocks, 
      '1000 thinking blocks'
    );
    
    // Should efficiently skip sanitization for thinking blocks
    expect(duration).toBeLessThan(30);
  });

  test('memory usage should not grow excessively', () => {
    const initialMemory = process.memoryUsage().heapUsed;
    
    // Process multiple large payloads
    for (let i = 0; i < 10; i++) {
      const payload = createLargePayload(1024); // 1MB each
      sanitizePayload(payload);
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryGrowth = (finalMemory - initialMemory) / (1024 * 1024); // MB
    
    console.log(`[MEMORY] Growth: ${memoryGrowth.toFixed(2)}MB`);
    
    // Memory growth should be reasonable (less than 50MB)
    expect(memoryGrowth).toBeLessThan(50);
  });
});