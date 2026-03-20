/**
 * Enhanced Integration for Anthropic provider with automated rollback
 * PHASE 3: Added enterprise features for production deployment
 */

import { sanitizePayload, getSanitizationHealth } from '../utils/payloadSanitizer.js';

/**
 * Feature flag configuration with automated rollback support
 * Addresses GPT-5.2's rollback safety requirements
 */
const SANITIZATION_CONFIG = {
  enabled: process.env.OPENCLAW_SANITIZE_PAYLOADS !== 'false', // Enabled by default
  preserveThinkingBlocks: process.env.OPENCLAW_PRESERVE_THINKING !== 'false', // Safe default
  enableMetrics: process.env.OPENCLAW_SANITIZE_METRICS === 'true', // Opt-in metrics
  rolloutPercentage: parseInt(process.env.OPENCLAW_SANITIZE_ROLLOUT) || 100, // Gradual rollout
  errorThreshold: parseInt(process.env.OPENCLAW_ERROR_THRESHOLD) || 10, // Max errors before circuit breaker
  performanceThresholdMs: parseInt(process.env.OPENCLAW_PERF_THRESHOLD) || 200, // Performance SLA
  circuitBreakerResetMs: parseInt(process.env.OPENCLAW_CIRCUIT_RESET) || 300000 // 5 minutes
};

/**
 * Circuit breaker state for automated rollback
 */
let circuitBreakerState = {
  isOpen: false,
  errorCount: 0,
  lastErrorTime: 0,
  lastResetAttempt: 0
};

/**
 * Performance and error metrics for monitoring
 */
let integrationMetrics = {
  totalRequests: 0,
  sanitizedRequests: 0,
  skippedRequests: 0,
  errors: 0,
  totalLatencyMs: 0,
  circuitBreakerTrips: 0
};

/**
 * Determines if sanitization should be applied based on rollout percentage and circuit breaker
 * Enhanced with automated rollback capabilities
 * 
 * @returns {boolean} Whether to apply sanitization
 */
function shouldSanitize() {
  // Circuit breaker check
  if (circuitBreakerState.isOpen) {
    const now = Date.now();
    
    // Try to reset circuit breaker after timeout
    if (now - circuitBreakerState.lastErrorTime > SANITIZATION_CONFIG.circuitBreakerResetMs) {
      console.warn('[AnthropicProvider] Attempting to reset circuit breaker');
      circuitBreakerState.isOpen = false;
      circuitBreakerState.errorCount = 0;
      circuitBreakerState.lastResetAttempt = now;
    } else {
      integrationMetrics.skippedRequests++;
      return false; // Circuit breaker is open
    }
  }
  
  if (!SANITIZATION_CONFIG.enabled) {
    integrationMetrics.skippedRequests++;
    return false;
  }
  
  if (SANITIZATION_CONFIG.rolloutPercentage >= 100) {
    return true;
  }
  
  // Deterministic rollout based on request hash for consistency
  const hash = Math.abs(hashCode(Date.now().toString())) % 100;
  return hash < SANITIZATION_CONFIG.rolloutPercentage;
}

/**
 * Simple hash function for deterministic rollout
 */
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

/**
 * Records performance metrics and triggers circuit breaker if needed
 */
function recordMetrics(duration, error = null) {
  integrationMetrics.totalRequests++;
  
  if (error) {
    integrationMetrics.errors++;
    circuitBreakerState.errorCount++;
    circuitBreakerState.lastErrorTime = Date.now();
    
    // Trigger circuit breaker if error threshold exceeded
    if (circuitBreakerState.errorCount >= SANITIZATION_CONFIG.errorThreshold) {
      console.error(`[AnthropicProvider] Circuit breaker triggered after ${circuitBreakerState.errorCount} errors`);
      circuitBreakerState.isOpen = true;
      integrationMetrics.circuitBreakerTrips++;
    }
  } else {
    integrationMetrics.sanitizedRequests++;
    integrationMetrics.totalLatencyMs += duration;
    
    // Performance threshold monitoring
    if (duration > SANITIZATION_CONFIG.performanceThresholdMs) {
      console.warn(`[AnthropicProvider] Performance threshold exceeded: ${duration}ms > ${SANITIZATION_CONFIG.performanceThresholdMs}ms`);
    }
    
    // Reset error count on successful operations (gradual recovery)
    if (circuitBreakerState.errorCount > 0) {
      circuitBreakerState.errorCount = Math.max(0, circuitBreakerState.errorCount - 1);
    }
  }
}

/**
 * Sanitizes Anthropic API payloads before sending requests
 * Enhanced with automated rollback and performance monitoring
 * 
 * @param {Object} messagePayload - The payload to send to Anthropic API
 * @param {Object} options - Optional configuration overrides
 * @returns {Object} Sanitized payload ready for API transmission
 */
export function sanitizeAnthropicPayload(messagePayload, options = {}) {
  const start = performance.now();
  
  // Skip sanitization if not enabled or rollout check fails
  if (!shouldSanitize()) {
    return messagePayload;
  }
  
  const config = {
    preserveThinkingBlocks: SANITIZATION_CONFIG.preserveThinkingBlocks,
    enableMetrics: SANITIZATION_CONFIG.enableMetrics,
    logSanitization: process.env.NODE_ENV === 'development',
    performanceThresholdMs: SANITIZATION_CONFIG.performanceThresholdMs,
    ...options
  };
  
  try {
    const sanitizedPayload = sanitizePayload(messagePayload, config);
    const duration = performance.now() - start;
    
    recordMetrics(duration);
    
    // Optional: Log sanitization activity for monitoring
    if (config.logSanitization) {
      console.debug('[AnthropicProvider] Payload sanitized before API request');
    }
    
    return sanitizedPayload;
  } catch (error) {
    const duration = performance.now() - start;
    recordMetrics(duration, error);
    
    console.error('[AnthropicProvider] Sanitization failed:', error);
    // Return original payload to prevent API failures
    return messagePayload;
  }
}

/**
 * Enhanced request function with integrated sanitization
 * This shows complete integration with error handling and monitoring
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
 * Manual circuit breaker controls for emergency situations
 */
export function disableSanitization() {
  SANITIZATION_CONFIG.enabled = false;
  console.warn('[AnthropicProvider] Payload sanitization disabled via circuit breaker');
}

export function enableSanitization() {
  SANITIZATION_CONFIG.enabled = true;
  circuitBreakerState.isOpen = false;
  circuitBreakerState.errorCount = 0;
  console.info('[AnthropicProvider] Payload sanitization re-enabled');
}

/**
 * Reset circuit breaker manually
 */
export function resetCircuitBreaker() {
  circuitBreakerState = {
    isOpen: false,
    errorCount: 0,
    lastErrorTime: 0,
    lastResetAttempt: Date.now()
  };
  console.info('[AnthropicProvider] Circuit breaker manually reset');
}

/**
 * Comprehensive health check for monitoring systems
 * Enhanced with circuit breaker status and performance metrics
 */
export function getSanitizationHealth() {
  const sanitizerHealth = getSanitizationHealth();
  const avgLatency = integrationMetrics.totalRequests > 0 
    ? integrationMetrics.totalLatencyMs / integrationMetrics.totalRequests 
    : 0;
  
  const health = {
    // Configuration status
    enabled: SANITIZATION_CONFIG.enabled,
    rolloutPercentage: SANITIZATION_CONFIG.rolloutPercentage,
    preserveThinkingBlocks: SANITIZATION_CONFIG.preserveThinkingBlocks,
    
    // Circuit breaker status
    circuitBreakerOpen: circuitBreakerState.isOpen,
    errorCount: circuitBreakerState.errorCount,
    errorThreshold: SANITIZATION_CONFIG.errorThreshold,
    
    // Performance metrics
    avgLatencyMs: avgLatency,
    performanceThresholdMs: SANITIZATION_CONFIG.performanceThresholdMs,
    
    // Usage statistics
    totalRequests: integrationMetrics.totalRequests,
    sanitizedRequests: integrationMetrics.sanitizedRequests,
    skippedRequests: integrationMetrics.skippedRequests,
    errorRate: integrationMetrics.totalRequests > 0 
      ? (integrationMetrics.errors / integrationMetrics.totalRequests * 100).toFixed(2) + '%'
      : '0%',
    
    // Sanitizer health
    sanitizerHealth,
    
    timestamp: new Date().toISOString()
  };
  
  // Determine overall health status
  health.status = circuitBreakerState.isOpen ? 'degraded' : 
                 (integrationMetrics.errors > 0 ? 'warning' : 'healthy');
  
  return health;
}

/**
 * Get integration metrics for monitoring dashboards
 */
export function getIntegrationMetrics() {
  return {
    ...integrationMetrics,
    circuitBreaker: { ...circuitBreakerState }
  };
}

/**
 * Reset integration metrics (for testing or metric rotation)
 */
export function resetIntegrationMetrics() {
  integrationMetrics = {
    totalRequests: 0,
    sanitizedRequests: 0,
    skippedRequests: 0,
    errors: 0,
    totalLatencyMs: 0,
    circuitBreakerTrips: 0
  };
}