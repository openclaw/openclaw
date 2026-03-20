/**
 * Type-Aware Payload Sanitization for OpenClaw Issue #27825
 * Prevents sanitizeSurrogates() from corrupting signed Anthropic thinking blocks
 * while maintaining Unicode safety for all other content
 */

import { sanitizeSurrogates, hasLoneSurrogates } from './surrogateSanitizer.js';

/**
 * Configuration for payload sanitization behavior
 */
const DEFAULT_OPTIONS = {
  preserveThinkingBlocks: true, // Safe by default - preserve signed thinking blocks
  logSanitization: process.env.NODE_ENV !== 'production', // Debug logging in dev
  enableMetrics: false // Can be enabled for observability
};

/**
 * Sanitization metrics for observability
 */
let sanitizationMetrics = {
  totalProcessed: 0,
  thinkingBlocksPreserved: 0,
  stringsSanitized: 0,
  loneSurrogatesFound: 0
};

/**
 * Sanitizes payload while intelligently preserving thinking blocks
 * Uses type-aware traversal to bypass sanitization for signed thinking blocks
 * 
 * @param {any} payload - The payload to sanitize (objects, arrays, primitives)
 * @param {Object} options - Configuration options
 * @param {boolean} options.preserveThinkingBlocks - Whether to bypass thinking block sanitization (default: true)
 * @param {boolean} options.logSanitization - Whether to log sanitization activity (default: dev only)
 * @param {boolean} options.enableMetrics - Whether to collect metrics (default: false)
 * @returns {any} Sanitized payload with preserved thinking blocks
 */
export function sanitizePayload(payload, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  
  if (config.enableMetrics) {
    sanitizationMetrics.totalProcessed++;
  }

  try {
    return traverseAndSanitize(payload, config);
  } catch (error) {
    if (config.logSanitization) {
      console.warn('[OpenClaw:PayloadSanitizer] Sanitization failed:', error.message);
    }
    // Return original payload on error to prevent breaking the pipeline
    return payload;
  }
}

/**
 * Recursively traverses and sanitizes payload structure
 * Implements deep cloning to avoid mutations of original payload
 * 
 * @param {any} node - Current node being processed
 * @param {Object} config - Sanitization configuration
 * @returns {any} Sanitized node
 */
function traverseAndSanitize(node, config) {
  // Handle null/undefined
  if (node == null) {
    return node;
  }

  // Thinking block detection and preservation
  if (config.preserveThinkingBlocks && 
      typeof node === 'object' && 
      node.type === 'thinking' && 
      node.signature) {
    
    if (config.enableMetrics) {
      sanitizationMetrics.thinkingBlocksPreserved++;
    }
    
    if (config.logSanitization) {
      console.debug('[OpenClaw:PayloadSanitizer] Preserved thinking block with signature');
    }
    
    // Return shallow copy to avoid mutations while preserving all properties
    return { ...node };
  }

  // String sanitization
  if (typeof node === 'string') {
    if (config.enableMetrics && hasLoneSurrogates(node)) {
      sanitizationMetrics.loneSurrogatesFound++;
    }
    
    const sanitized = sanitizeSurrogates(node);
    
    if (config.enableMetrics && sanitized !== node) {
      sanitizationMetrics.stringsSanitized++;
    }
    
    return sanitized;
  }

  // Array traversal with deep cloning
  if (Array.isArray(node)) {
    return node.map(item => traverseAndSanitize(item, config));
  }

  // Object traversal with deep cloning
  if (typeof node === 'object') {
    const result = {};
    
    // Use Object.getOwnPropertyNames to handle non-enumerable properties
    for (const key of Object.keys(node)) {
      // Skip prototype pollution
      if (!Object.prototype.hasOwnProperty.call(node, key)) {
        continue;
      }
      
      result[key] = traverseAndSanitize(node[key], config);
    }
    
    return result;
  }

  // Primitive values (numbers, booleans, etc.)
  return node;
}

/**
 * Gets current sanitization metrics
 * Useful for monitoring and debugging
 * 
 * @returns {Object} Current metrics snapshot
 */
export function getSanitizationMetrics() {
  return { ...sanitizationMetrics };
}

/**
 * Resets sanitization metrics
 * Useful for testing and metric collection periods
 */
export function resetSanitizationMetrics() {
  sanitizationMetrics = {
    totalProcessed: 0,
    thinkingBlocksPreserved: 0,
    stringsSanitized: 0,
    loneSurrogatesFound: 0
  };
}

/**
 * Creates a pre-configured sanitizer for specific use cases
 * 
 * @param {Object} defaultConfig - Default configuration for this sanitizer instance
 * @returns {Function} Configured sanitizer function
 */
export function createSanitizer(defaultConfig = {}) {
  return (payload, options = {}) => {
    return sanitizePayload(payload, { ...defaultConfig, ...options });
  };
}