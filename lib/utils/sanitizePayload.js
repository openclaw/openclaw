/**
 * Type-Aware Sanitization for OpenClaw Issue #27825
 * Prevents sanitizeSurrogates() from corrupting signed Anthropic thinking blocks
 */

import { sanitizeSurrogates } from './surrogate-sanitizer.js';

/**
 * Sanitizes payload while preserving thinking blocks with valid signatures
 * @param {any} payload - The payload to sanitize
 * @param {Object} options - Configuration options
 * @param {boolean} options.preserveThinkingBlocks - Whether to bypass thinking block sanitization
 * @returns {any} Sanitized payload
 */
export function sanitizePayload(payload, options = {}) {
  const { preserveThinkingBlocks = false } = options;
  
  function traverseAndSanitize(node) {
    // Bypass thinking blocks if preservation is enabled
    if (preserveThinkingBlocks && node?.type === 'thinking' && node?.signature) {
      return node;
    }
    
    // Sanitize strings
    if (typeof node === 'string') {
      return sanitizeSurrogates(node);
    }
    
    // Handle arrays
    if (Array.isArray(node)) {
      return node.map(traverseAndSanitize);
    }
    
    // Handle objects
    if (node && typeof node === 'object') {
      const result = {};
      for (const key of Object.keys(node)) {
        result[key] = traverseAndSanitize(node[key]);
      }
      return result;
    }
    
    return node;
  }
  
  return traverseAndSanitize(payload);
}