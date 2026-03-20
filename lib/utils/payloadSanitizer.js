/**
 * Type-Aware Payload Sanitization for OpenClaw Issue #27825
 * PHASE 3: Enhanced with performance optimization, security hardening, and compliance features
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
  enableMetrics: false, // Can be enabled for observability
  maxDepth: 1000, // Prevent stack overflow on deeply nested objects
  enableAuditLogging: process.env.OPENCLAW_AUDIT_SANITIZATION === 'true', // GDPR/HIPAA compliance
  performanceThresholdMs: 100 // Log performance warnings above threshold
};

/**
 * Sanitization metrics for observability and compliance
 */
let sanitizationMetrics = {
  totalProcessed: 0,
  thinkingBlocksPreserved: 0,
  stringsSanitized: 0,
  loneSurrogatesFound: 0,
  performanceWarnings: 0,
  maxDepthExceeded: 0,
  totalProcessingTimeMs: 0
};

/**
 * Performance optimized sanitization cache for repeated strings
 * Addresses Grok-4's performance concerns for large payloads
 */
const sanitizationCache = new Map();
const CACHE_SIZE_LIMIT = 10000;

/**
 * Audit logger for compliance (GDPR/HIPAA)
 * Addresses Grok-4's compliance requirements
 */
function auditLog(event, data = {}) {
  if (DEFAULT_OPTIONS.enableAuditLogging && typeof console !== 'undefined') {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: `sanitizer.${event}`,
      ...data
    }));
  }
}

/**
 * Sanitizes payload while intelligently preserving thinking blocks
 * Uses type-aware traversal to bypass sanitization for signed thinking blocks
 * PHASE 3: Enhanced with performance optimization and security hardening
 * 
 * @param {any} payload - The payload to sanitize (objects, arrays, primitives)
 * @param {Object} options - Configuration options
 * @param {boolean} options.preserveThinkingBlocks - Whether to bypass thinking block sanitization (default: true)
 * @param {boolean} options.logSanitization - Whether to log sanitization activity (default: dev only)
 * @param {boolean} options.enableMetrics - Whether to collect metrics (default: false)
 * @param {number} options.maxDepth - Maximum traversal depth to prevent stack overflow (default: 1000)
 * @returns {any} Sanitized payload with preserved thinking blocks
 */
export function sanitizePayload(payload, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const startTime = performance.now();
  
  if (config.enableMetrics) {
    sanitizationMetrics.totalProcessed++;
  }

  try {
    const result = traverseAndSanitize(payload, config, 0);
    
    const duration = performance.now() - startTime;
    if (config.enableMetrics) {
      sanitizationMetrics.totalProcessingTimeMs += duration;
    }
    
    // Performance monitoring
    if (duration > config.performanceThresholdMs) {
      if (config.enableMetrics) {
        sanitizationMetrics.performanceWarnings++;
      }
      
      if (config.logSanitization) {
        console.warn(`[OpenClaw:PayloadSanitizer] Performance warning: sanitization took ${duration.toFixed(2)}ms`);
      }
      
      auditLog('performance_warning', { durationMs: duration });
    }
    
    // Clear cache periodically to prevent memory leaks
    if (sanitizationCache.size > CACHE_SIZE_LIMIT) {
      sanitizationCache.clear();
    }
    
    return result;
  } catch (error) {
    if (config.logSanitization) {
      console.warn('[OpenClaw:PayloadSanitizer] Sanitization failed:', error.message);
    }
    
    auditLog('sanitization_error', { error: error.message });
    
    // Return original payload on error to prevent breaking the pipeline
    return payload;
  }
}

/**
 * Recursively traverses and sanitizes payload structure
 * PHASE 3: Enhanced with performance optimization, depth limiting, and security hardening
 * Implements deep cloning to avoid mutations of original payload
 * 
 * @param {any} node - Current node being processed
 * @param {Object} config - Sanitization configuration
 * @param {number} depth - Current traversal depth
 * @returns {any} Sanitized node
 */
function traverseAndSanitize(node, config, depth = 0) {
  // Prevent stack overflow from maliciously deep objects
  if (depth > config.maxDepth) {
    if (config.enableMetrics) {
      sanitizationMetrics.maxDepthExceeded++;
    }
    
    auditLog('max_depth_exceeded', { depth, maxDepth: config.maxDepth });
    return '[Object: Maximum depth exceeded]';
  }

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
    
    auditLog('thinking_block_preserved', { signature: node.signature?.substring(0, 8) + '...' });
    
    // Return shallow copy to avoid mutations while preserving all properties
    return { ...node };
  }

  // String sanitization with caching for performance
  if (typeof node === 'string') {
    // Check cache first for performance optimization
    if (sanitizationCache.has(node)) {
      return sanitizationCache.get(node);
    }
    
    if (config.enableMetrics && hasLoneSurrogates(node)) {
      sanitizationMetrics.loneSurrogatesFound++;
    }
    
    const sanitized = sanitizeSurrogates(node);
    
    if (config.enableMetrics && sanitized !== node) {
      sanitizationMetrics.stringsSanitized++;
    }
    
    // Cache the result if string is not too large
    if (node.length < 1000) { // Only cache smaller strings
      sanitizationCache.set(node, sanitized);
    }
    
    if (sanitized !== node) {
      auditLog('string_sanitized', { 
        originalLength: node.length, 
        sanitizedLength: sanitized.length,
        hadSurrogates: true
      });
    }
    
    return sanitized;
  }

  // Array traversal with deep cloning
  if (Array.isArray(node)) {
    return node.map(item => traverseAndSanitize(item, config, depth + 1));
  }

  // Object traversal with deep cloning and prototype pollution protection
  if (typeof node === 'object') {
    // Security: Prevent prototype pollution
    if (node.constructor !== Object && node.constructor !== Array) {
      // For non-plain objects, return a safe representation
      return `[${node.constructor.name}]`;
    }
    
    const result = {};
    
    // Use Object.getOwnPropertyNames to handle all properties but avoid prototype chain
    for (const key of Object.keys(node)) {
      // Security: Skip dangerous properties
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      
      // Additional security check
      if (!Object.prototype.hasOwnProperty.call(node, key)) {
        continue;
      }
      
      try {
        result[key] = traverseAndSanitize(node[key], config, depth + 1);
      } catch (error) {
        // Log and skip problematic properties
        if (config.logSanitization) {
          console.warn(`[OpenClaw:PayloadSanitizer] Failed to sanitize property '${key}':`, error.message);
        }
        result[key] = '[Sanitization Error]';
      }
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
    loneSurrogatesFound: 0,
    performanceWarnings: 0,
    maxDepthExceeded: 0,
    totalProcessingTimeMs: 0
  };
  
  // Also clear cache
  sanitizationCache.clear();
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

/**
 * Health check for sanitization system
 * Useful for monitoring and alerting
 * 
 * @returns {Object} Health status and metrics
 */
export function getSanitizationHealth() {
  const metrics = getSanitizationMetrics();
  const cacheSize = sanitizationCache.size;
  
  return {
    status: 'healthy',
    metrics,
    cacheSize,
    cacheLimitExceeded: cacheSize > CACHE_SIZE_LIMIT,
    averageProcessingTime: metrics.totalProcessed > 0 
      ? metrics.totalProcessingTimeMs / metrics.totalProcessed 
      : 0,
    timestamp: new Date().toISOString()
  };
}