/**
 * Integration example for Anthropic provider
 * Shows how to integrate payload sanitization into existing pipeline
 */

import { sanitizePayload } from '../utils/payloadSanitizer.js';

/**
 * Feature flag for payload sanitization
 * Can be controlled via environment variables for gradual rollout
 */
const SANITIZATION_CONFIG = {
  enabled: process.env.OPENCLAW_SANITIZE_PAYLOADS !== 'false', // Enabled by default
  preserveThinkingBlocks: process.env.OPENCLAW_PRESERVE_THINKING !== 'false', // Safe default
  enableMetrics: process.env.OPENCLAW_SANITIZE_METRICS === 'true', // Opt-in metrics
  rolloutPercentage: parseInt(process.env.OPENCLAW_SANITIZE_ROLLOUT) || 100 // Gradual rollout
};

/**
 * Determines if sanitization should be applied based on rollout percentage
 * Supports gradual deployment and A/B testing
 * 
 * @returns {boolean} Whether to apply sanitization
 */
function shouldSanitize() {
  if (!SANITIZATION_CONFIG.enabled) {
    return false;
  }
  
  if (SANITIZATION_CONFIG.rolloutPercentage >= 100) {
    return true;
  }
  
  // Simple percentage-based rollout (could be enhanced with user-based hashing)
  return Math.random() * 100 < SANITIZATION_CONFIG.rolloutPercentage;
}

/**
 * Sanitizes Anthropic API payloads before sending requests
 * This would typically be integrated into the existing Anthropic provider
 * 
 * @param {Object} messagePayload - The payload to send to Anthropic API
 * @param {Object} options - Optional configuration overrides
 * @returns {Object} Sanitized payload ready for API transmission
 */
export function sanitizeAnthropicPayload(messagePayload, options = {}) {
  // Skip sanitization if not enabled or rollout check fails
  if (!shouldSanitize()) {
    return messagePayload;
  }
  
  const config = {
    preserveThinkingBlocks: SANITIZATION_CONFIG.preserveThinkingBlocks,
    enableMetrics: SANITIZATION_CONFIG.enableMetrics,
    logSanitization: process.env.NODE_ENV === 'development',
    ...options
  };
  
  try {
    const sanitizedPayload = sanitizePayload(messagePayload, config);
    
    // Optional: Log sanitization activity for monitoring
    if (config.logSanitization) {
      console.debug('[AnthropicProvider] Payload sanitized before API request');
    }
    
    return sanitizedPayload;
  } catch (error) {
    console.error('[AnthropicProvider] Sanitization failed:', error);
    // Return original payload to prevent API failures
    return messagePayload;
  }
}

/**
 * Example integration point for existing Anthropic provider
 * This shows where sanitization would be added to the request pipeline
 */
export function sendAnthropicRequest(messages, model, options = {}) {
  // Build the standard Anthropic API payload
  const apiPayload = {
    model,
    messages,
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature || 0.7
  };
  
  // INTEGRATION POINT: Sanitize before sending
  const sanitizedPayload = sanitizeAnthropicPayload(apiPayload, options.sanitization);
  
  // Continue with existing request logic...
  // return fetch('https://api.anthropic.com/v1/messages', {
  //   method: 'POST',
  //   headers: { ... },
  //   body: JSON.stringify(sanitizedPayload)
  // });
  
  return sanitizedPayload; // For testing purposes
}

/**
 * Emergency circuit breaker for sanitization
 * Allows immediate rollback without deployment
 */
export function disableSanitization() {
  SANITIZATION_CONFIG.enabled = false;
  console.warn('[AnthropicProvider] Payload sanitization disabled via circuit breaker');
}

/**
 * Health check for sanitization system
 * Can be used by monitoring systems
 */
export function getSanitizationHealth() {
  return {
    enabled: SANITIZATION_CONFIG.enabled,
    rolloutPercentage: SANITIZATION_CONFIG.rolloutPercentage,
    preserveThinkingBlocks: SANITIZATION_CONFIG.preserveThinkingBlocks,
    timestamp: new Date().toISOString()
  };
}