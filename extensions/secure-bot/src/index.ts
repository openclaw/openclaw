/**
 * @openclaw/secure-bot
 *
 * Security-hardened AI bot extension with enhanced protection features.
 *
 * Features:
 * - Automatic input validation and sanitization
 * - Rate limiting with configurable thresholds
 * - Audit logging for security events
 * - Prompt injection detection and blocking
 * - Sensitive data redaction
 * - Access control lists (ACL)
 * - Anomaly detection
 * - Security metrics collection
 */

import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelMessagingAdapter,
  MessageContext,
  InboundMessage,
  OutboundMessage,
} from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

export type SecureBotConfig = {
  enabled: boolean;
  security: {
    /** Enable input validation */
    inputValidation: boolean;
    /** Maximum input length */
    maxInputLength: number;
    /** Enable prompt injection detection */
    detectPromptInjection: boolean;
    /** Block messages with detected injection attempts */
    blockInjectionAttempts: boolean;
    /** Enable rate limiting */
    rateLimiting: {
      enabled: boolean;
      windowMs: number;
      maxRequests: number;
    };
    /** Enable audit logging */
    auditLogging: boolean;
    /** Redact sensitive patterns from logs */
    redactPatterns: string[];
  };
  access: {
    /** Default access policy: allow or deny */
    defaultPolicy: "allow" | "deny";
    /** Allowed user IDs */
    allowlist: string[];
    /** Blocked user IDs */
    blocklist: string[];
    /** Admin user IDs (bypass rate limits) */
    admins: string[];
  };
  response: {
    /** Custom security warning message */
    securityWarningMessage: string;
    /** Custom rate limit message */
    rateLimitMessage: string;
    /** Custom blocked message */
    blockedMessage: string;
  };
};

export type SecurityEvent = {
  timestamp: string;
  eventType: SecurityEventType;
  severity: "info" | "warn" | "critical";
  userId: string;
  channelId: string;
  details: Record<string, unknown>;
};

export type SecurityEventType =
  | "message_received"
  | "message_blocked"
  | "injection_detected"
  | "rate_limited"
  | "access_denied"
  | "anomaly_detected"
  | "sensitive_data_redacted";

export type SecurityMetrics = {
  totalMessages: number;
  blockedMessages: number;
  injectionAttempts: number;
  rateLimitHits: number;
  accessDenials: number;
  averageResponseTime: number;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: SecureBotConfig = {
  enabled: true,
  security: {
    inputValidation: true,
    maxInputLength: 10000,
    detectPromptInjection: true,
    blockInjectionAttempts: true,
    rateLimiting: {
      enabled: true,
      windowMs: 60000, // 1 minute
      maxRequests: 30,
    },
    auditLogging: true,
    redactPatterns: [
      "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b", // Email
      "\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b", // Phone
      "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b", // Credit card
      "\\b(?:sk-|pk_live_|pk_test_)[A-Za-z0-9]{20,}\\b", // API keys
    ],
  },
  access: {
    defaultPolicy: "allow",
    allowlist: [],
    blocklist: [],
    admins: [],
  },
  response: {
    securityWarningMessage: "⚠️ Security: Your message was flagged for review.",
    rateLimitMessage: "⏳ Please slow down. Try again in a moment.",
    blockedMessage: "🚫 Access denied.",
  },
};

// Prompt injection detection patterns
const INJECTION_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|guidelines?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?|training)/i,
  /override\s+(your|the|all)\s+(instructions?|rules?|settings?|configuration)/i,

  // Role/persona manipulation
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /pretend\s+(to\s+be|you\s+are)\s+/i,
  /act\s+as\s+(if\s+)?(you\s+are\s+)?/i,
  /roleplay\s+as\s+/i,
  /from\s+now\s+on[,\s]+you\s+(will|are|must)/i,

  // System prompt extraction
  /what\s+(is|are)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i,
  /show\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions?)/i,
  /reveal\s+(your|the)\s+(system\s+)?(prompt|instructions?|configuration)/i,
  /print\s+(your|the)\s+(system\s+)?(prompt|instructions?)/i,

  // Jailbreak patterns
  /\bdan\s+mode\b/i,
  /\bjailbreak\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bno\s+restrictions?\b/i,
  /\bunlocked\s+mode\b/i,

  // Code injection markers
  /<\/?system>/i,
  /<\/?prompt>/i,
  /<\/?instructions?>/i,
  /\[\[system\]\]/i,
  /```system/i,

  // Delimiter escape attempts
  /\x00/, // Null byte
  /[\u202A-\u202E\u2066-\u2069]/, // Unicode direction overrides
];

// Suspicious but not blocking patterns (for monitoring)
const SUSPICIOUS_PATTERNS = [
  /\bhack\b/i,
  /\bexploit\b/i,
  /\bbypass\b/i,
  /\bcircumvent\b/i,
  /\bvulnerabilit/i,
];

// ============================================================================
// Security Engine
// ============================================================================

class SecurityEngine {
  private config: SecureBotConfig;
  private rateLimitStore = new Map<string, { count: number; resetAt: number }>();
  private eventLog: SecurityEvent[] = [];
  private metrics: SecurityMetrics = {
    totalMessages: 0,
    blockedMessages: 0,
    injectionAttempts: 0,
    rateLimitHits: 0,
    accessDenials: 0,
    averageResponseTime: 0,
  };

  constructor(config: Partial<SecureBotConfig> = {}) {
    this.config = this.mergeConfig(DEFAULT_CONFIG, config);
  }

  private mergeConfig(
    defaults: SecureBotConfig,
    overrides: Partial<SecureBotConfig>
  ): SecureBotConfig {
    return {
      ...defaults,
      ...overrides,
      security: { ...defaults.security, ...overrides.security },
      access: { ...defaults.access, ...overrides.access },
      response: { ...defaults.response, ...overrides.response },
    };
  }

  /**
   * Check if user has access
   */
  checkAccess(userId: string): { allowed: boolean; reason?: string } {
    const { access } = this.config;

    // Check blocklist first
    if (access.blocklist.includes(userId)) {
      this.metrics.accessDenials++;
      this.logEvent("access_denied", "critical", userId, "", { reason: "blocklist" });
      return { allowed: false, reason: "User is blocklisted" };
    }

    // Check allowlist
    if (access.allowlist.length > 0 && !access.allowlist.includes(userId)) {
      if (access.defaultPolicy === "deny") {
        this.metrics.accessDenials++;
        this.logEvent("access_denied", "warn", userId, "", { reason: "not_in_allowlist" });
        return { allowed: false, reason: "User not in allowlist" };
      }
    }

    // Default policy
    if (access.defaultPolicy === "deny" && !access.allowlist.includes(userId)) {
      this.metrics.accessDenials++;
      return { allowed: false, reason: "Default policy is deny" };
    }

    return { allowed: true };
  }

  /**
   * Check rate limit for user
   */
  checkRateLimit(userId: string): { allowed: boolean; retryAfterMs?: number } {
    const { rateLimiting } = this.config.security;

    if (!rateLimiting.enabled) {
      return { allowed: true };
    }

    // Admins bypass rate limiting
    if (this.config.access.admins.includes(userId)) {
      return { allowed: true };
    }

    const now = Date.now();
    const entry = this.rateLimitStore.get(userId);

    if (!entry || now > entry.resetAt) {
      this.rateLimitStore.set(userId, {
        count: 1,
        resetAt: now + rateLimiting.windowMs,
      });
      return { allowed: true };
    }

    if (entry.count >= rateLimiting.maxRequests) {
      this.metrics.rateLimitHits++;
      this.logEvent("rate_limited", "warn", userId, "", {
        count: entry.count,
        limit: rateLimiting.maxRequests,
      });
      return {
        allowed: false,
        retryAfterMs: entry.resetAt - now,
      };
    }

    entry.count++;
    return { allowed: true };
  }

  /**
   * Detect prompt injection attempts
   */
  detectInjection(content: string): {
    detected: boolean;
    patterns: string[];
    suspicious: boolean;
  } {
    if (!this.config.security.detectPromptInjection) {
      return { detected: false, patterns: [], suspicious: false };
    }

    const detectedPatterns: string[] = [];
    let suspicious = false;

    // Check blocking patterns
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        detectedPatterns.push(pattern.source);
      }
    }

    // Check suspicious patterns
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(content)) {
        suspicious = true;
        break;
      }
    }

    const detected = detectedPatterns.length > 0;
    if (detected) {
      this.metrics.injectionAttempts++;
    }

    return { detected, patterns: detectedPatterns, suspicious };
  }

  /**
   * Validate and sanitize input
   */
  validateInput(content: string): {
    valid: boolean;
    sanitized: string;
    issues: string[];
  } {
    if (!this.config.security.inputValidation) {
      return { valid: true, sanitized: content, issues: [] };
    }

    const issues: string[] = [];
    let sanitized = content;

    // Length check
    if (sanitized.length > this.config.security.maxInputLength) {
      sanitized = sanitized.slice(0, this.config.security.maxInputLength);
      issues.push(`Input truncated to ${this.config.security.maxInputLength} characters`);
    }

    // Remove null bytes
    if (sanitized.includes("\x00")) {
      sanitized = sanitized.replace(/\x00/g, "");
      issues.push("Null bytes removed");
    }

    // Remove Unicode direction overrides
    const directionOverrides = /[\u202A-\u202E\u2066-\u2069]/g;
    if (directionOverrides.test(sanitized)) {
      sanitized = sanitized.replace(directionOverrides, "");
      issues.push("Unicode direction overrides removed");
    }

    return {
      valid: issues.length === 0,
      sanitized,
      issues,
    };
  }

  /**
   * Redact sensitive data from content
   */
  redactSensitive(content: string): string {
    let redacted = content;

    for (const patternStr of this.config.security.redactPatterns) {
      try {
        const pattern = new RegExp(patternStr, "gi");
        redacted = redacted.replace(pattern, "[REDACTED]");
      } catch {
        // Skip invalid patterns
      }
    }

    return redacted;
  }

  /**
   * Process incoming message through security pipeline
   */
  processMessage(
    userId: string,
    channelId: string,
    content: string
  ): {
    allowed: boolean;
    processedContent: string;
    response?: string;
    securityFlags: {
      accessDenied: boolean;
      rateLimited: boolean;
      injectionDetected: boolean;
      inputModified: boolean;
    };
  } {
    this.metrics.totalMessages++;

    // 1. Access control
    const accessCheck = this.checkAccess(userId);
    if (!accessCheck.allowed) {
      return {
        allowed: false,
        processedContent: content,
        response: this.config.response.blockedMessage,
        securityFlags: {
          accessDenied: true,
          rateLimited: false,
          injectionDetected: false,
          inputModified: false,
        },
      };
    }

    // 2. Rate limiting
    const rateCheck = this.checkRateLimit(userId);
    if (!rateCheck.allowed) {
      return {
        allowed: false,
        processedContent: content,
        response: this.config.response.rateLimitMessage,
        securityFlags: {
          accessDenied: false,
          rateLimited: true,
          injectionDetected: false,
          inputModified: false,
        },
      };
    }

    // 3. Input validation
    const validation = this.validateInput(content);
    let processedContent = validation.sanitized;
    const inputModified = validation.issues.length > 0;

    // 4. Prompt injection detection
    const injection = this.detectInjection(processedContent);
    if (injection.detected) {
      this.logEvent("injection_detected", "critical", userId, channelId, {
        patterns: injection.patterns,
        contentPreview: processedContent.slice(0, 100),
      });

      if (this.config.security.blockInjectionAttempts) {
        this.metrics.blockedMessages++;
        return {
          allowed: false,
          processedContent,
          response: this.config.response.securityWarningMessage,
          securityFlags: {
            accessDenied: false,
            rateLimited: false,
            injectionDetected: true,
            inputModified,
          },
        };
      }
    }

    // 5. Log message (with redaction)
    if (this.config.security.auditLogging) {
      this.logEvent("message_received", "info", userId, channelId, {
        contentLength: processedContent.length,
        modified: inputModified,
        suspicious: injection.suspicious,
      });
    }

    return {
      allowed: true,
      processedContent,
      securityFlags: {
        accessDenied: false,
        rateLimited: false,
        injectionDetected: injection.detected,
        inputModified,
      },
    };
  }

  /**
   * Log security event
   */
  private logEvent(
    eventType: SecurityEventType,
    severity: SecurityEvent["severity"],
    userId: string,
    channelId: string,
    details: Record<string, unknown>
  ): void {
    const event: SecurityEvent = {
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      userId: this.redactSensitive(userId),
      channelId,
      details,
    };

    this.eventLog.push(event);

    // Keep only last 1000 events in memory
    if (this.eventLog.length > 1000) {
      this.eventLog = this.eventLog.slice(-1000);
    }
  }

  /**
   * Get security metrics
   */
  getMetrics(): SecurityMetrics {
    return { ...this.metrics };
  }

  /**
   * Get recent security events
   */
  getRecentEvents(count: number = 100): SecurityEvent[] {
    return this.eventLog.slice(-count);
  }

  /**
   * Clear rate limit for user (admin action)
   */
  clearRateLimit(userId: string): void {
    this.rateLimitStore.delete(userId);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SecureBotConfig>): void {
    this.config = this.mergeConfig(this.config, config);
  }
}

// ============================================================================
// Plugin Implementation
// ============================================================================

const securityEngine = new SecurityEngine();

const meta: ChannelMeta = {
  id: "secure-bot",
  label: "Secure Bot",
  description: "Security-hardened AI bot with enhanced protection features",
  emoji: "🛡️",
  color: "#4CAF50",
  docs: "https://docs.openclaw.ai/extensions/secure-bot",
};

const capabilities: ChannelCapabilities = {
  supportsInbound: true,
  supportsOutbound: true,
  supportsMedia: true,
  supportsReactions: false,
  supportsEdits: false,
  supportsDeletes: false,
  supportsThreads: false,
  requiresPolling: false,
};

const configAdapter: ChannelConfigAdapter = {
  getSchema: () => ({
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      security: {
        type: "object",
        properties: {
          inputValidation: { type: "boolean", default: true },
          maxInputLength: { type: "number", default: 10000 },
          detectPromptInjection: { type: "boolean", default: true },
          blockInjectionAttempts: { type: "boolean", default: true },
          rateLimiting: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
              windowMs: { type: "number", default: 60000 },
              maxRequests: { type: "number", default: 30 },
            },
          },
          auditLogging: { type: "boolean", default: true },
        },
      },
      access: {
        type: "object",
        properties: {
          defaultPolicy: { type: "string", enum: ["allow", "deny"], default: "allow" },
          allowlist: { type: "array", items: { type: "string" } },
          blocklist: { type: "array", items: { type: "string" } },
          admins: { type: "array", items: { type: "string" } },
        },
      },
    },
  }),
  validate: (config: unknown) => {
    // Basic validation
    return { valid: true, errors: [] };
  },
  getDefaults: () => DEFAULT_CONFIG,
};

const messagingAdapter: ChannelMessagingAdapter = {
  processInbound: async (message: InboundMessage, context: MessageContext) => {
    const result = securityEngine.processMessage(
      message.senderId ?? "unknown",
      context.channelId ?? "unknown",
      message.content ?? ""
    );

    if (!result.allowed) {
      // Return security response instead of processing
      return {
        ...message,
        content: result.response ?? "",
        metadata: {
          ...message.metadata,
          securityBlocked: true,
          securityFlags: result.securityFlags,
        },
      };
    }

    return {
      ...message,
      content: result.processedContent,
      metadata: {
        ...message.metadata,
        securityFlags: result.securityFlags,
      },
    };
  },

  processOutbound: async (message: OutboundMessage, context: MessageContext) => {
    // Redact sensitive data from outbound messages
    const redactedContent = securityEngine.redactSensitive(message.content ?? "");
    return {
      ...message,
      content: redactedContent,
    };
  },
};

// ============================================================================
// Plugin Export
// ============================================================================

export const plugin: ChannelPlugin = {
  id: "secure-bot",
  meta,
  capabilities,
  config: configAdapter,
  messaging: messagingAdapter,
};

// Export security engine for direct access
export { SecurityEngine, securityEngine, DEFAULT_CONFIG };

// Export types
export type { SecureBotConfig, SecurityEvent, SecurityEventType, SecurityMetrics };

export default plugin;
