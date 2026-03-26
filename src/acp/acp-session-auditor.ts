/**
 * ACP Session Auditor: integrates audit monitoring into session lifecycle
 * Hooks into session completion to analyze and alert on issues
 */

import { AcpAuditMonitor, type AcpAuditSummary, type AcpSessionEvent } from "./acp-audit-monitor.js";

export interface SessionCompletionContext {
  sessionId: string;
  sessionKey: string;
  runtime?: string;
  startTime: number;
  endTime: number;
  isAcpSession: boolean;
  events?: AcpSessionEvent[];
  transcript?: { type: string; role?: string; content?: string }[];
}

export interface AuditorConfig {
  enabled?: boolean;
  alertOnCritical?: boolean;
  alertOnDestructive?: boolean;
  alertOnHallucination?: boolean;
  maxEventsPerSession?: number;
  /** Function to send alerts (e.g., via Telegram, email, logging) */
  alertHandler?: (summary: AcpAuditSummary, formattedMessage: string) => Promise<void>;
}

export class AcpSessionAuditor {
  private config: AuditorConfig;
  private monitor = AcpAuditMonitor;

  constructor(config: AuditorConfig = {}) {
    this.config = {
      enabled: true,
      alertOnCritical: true,
      alertOnDestructive: true,
      alertOnHallucination: false,
      maxEventsPerSession: 1000,
      ...config,
    };
  }

  /**
   * Audit a session on completion
   */
  async auditSessionCompletion(context: SessionCompletionContext): Promise<AcpAuditSummary | null> {
    if (!this.config.enabled || !context.isAcpSession) {
      return null;
    }

    // Extract events from transcript if not provided directly
    const events = context.events || this.extractEventsFromTranscript(context.transcript || []);

    if (events.length === 0) {
      return null;
    }

    // Limit events to prevent analysis of extremely long sessions
    const limitedEvents =
      events.length > (this.config.maxEventsPerSession || 1000)
        ? events.slice(0, this.config.maxEventsPerSession)
        : events;

    const summary = this.monitor.analyzeSessionEvents(
      context.sessionId,
      limitedEvents,
      context.startTime,
      context.endTime,
    );

    // Send alerts if configured
    if (this.config.alertHandler) {
      const shouldAlert = this.shouldSendAlert(summary);
      if (shouldAlert) {
        const formatted = this.monitor.formatSummary(summary);
        await this.config.alertHandler(summary, formatted).catch((err) => {
          console.error(`Failed to send audit alert: ${String(err)}`);
        });
      }
    }

    return summary;
  }

  /**
   * Extract session events from transcript
   */
  private extractEventsFromTranscript(
    transcript: { type?: string; role?: string; content?: string }[],
  ): AcpSessionEvent[] {
    const events: AcpSessionEvent[] = [];
    let eventIndex = 0;

    for (const item of transcript) {
      const type = (item.type || "").toLowerCase();
      const role = (item.role || "").toLowerCase();
      const content = item.content || "";

      let eventType: AcpSessionEvent["type"] = "message";

      if (type === "tool" || role === "tool") {
        eventType = "tool-call";
      } else if (type === "error" || role === "error") {
        eventType = "error";
      }

      if (content.trim()) {
        events.push({
          timestamp: Date.now() + eventIndex, // Approximate ordering
          type: eventType,
          content: content.slice(0, 500), // Limit content size
          toolName: type === "tool" ? content.split("\n")[0] : undefined,
        });
      }

      eventIndex += 1;
    }

    return events;
  }

  /**
   * Determine if alert should be sent based on config
   */
  private shouldSendAlert(summary: AcpAuditSummary): boolean {
    if (this.config.alertOnCritical && summary.severity === "critical") {
      return true;
    }

    if (this.config.alertOnDestructive && summary.destructiveCommands.length > 0) {
      return true;
    }

    if (this.config.alertOnHallucination && summary.hallucinations.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Get audit statistics for a session
   */
  getAuditStatistics(summary: AcpAuditSummary): Record<string, unknown> {
    return {
      sessionId: summary.sessionId,
      totalEvents: summary.totalEvents,
      toolCalls: summary.toolCallCount,
      duration: summary.duration,
      hallucinations: summary.hallucinations.length,
      destructiveCommands: summary.destructiveCommands.length,
      errors: summary.errors.length,
      severity: summary.severity,
      issues: summary.issues,
    };
  }
}
