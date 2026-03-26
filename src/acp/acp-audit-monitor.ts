/**
 * ACP Auto-Audit Monitor: post-session analysis and alerting
 * Detects hallucinations, destructive commands, and other issues
 */

export interface AcpSessionEvent {
  timestamp: number;
  type: "tool-call" | "message" | "error" | "hallucination";
  content: string;
  toolName?: string;
  isDestructive?: boolean;
  isHallucination?: boolean;
}

export interface AcpAuditSummary {
  sessionId: string;
  startTime: number;
  endTime: number;
  duration: number;
  toolCallCount: number;
  hallucinations: AcpSessionEvent[];
  destructiveCommands: AcpSessionEvent[];
  errors: AcpSessionEvent[];
  totalEvents: number;
  severity: "info" | "warning" | "critical";
  issues: string[];
}

const DESTRUCTIVE_COMMANDS = [
  /\brm\s+(-r|-f|--recursive|--force)/i,
  /\brm\s+-/,
  /\bdelete\b/i,
  /\b(unlink|rmdir)\b/i,
  /\b(git\s+reset|git\s+clean|git\s+rm)\s+--hard/i,
  /\b(dd|mkfs|fsck|format)\b/i,
  /\b(chmod\s+-R|chown\s+-R)\s+[0-7]/i,
  /\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE)\b/i,
  /\.\.\/.*\.env/i, // Accessing env files
];

const HALLUCINATION_INDICATORS = [
  /\b(I assume|I believe|I think|likely|probably|presumably)\b/i,
  /\b(I don't have access to|I can't see|I'm not sure)\b/i,
  /\b(could be|might be|appears to be)\s+\w+\s+(file|function|class|method)/i,
];

export class AcpAuditMonitor {
  /**
   * Analyze session for issues
   */
  static analyzeSessionEvents(
    sessionId: string,
    events: AcpSessionEvent[],
    startTime: number,
    endTime: number,
  ): AcpAuditSummary {
    const hallucinations = events.filter((e) => e.isHallucination || this.detectHallucination(e));
    const destructive = events.filter((e) => e.isDestructive || this.detectDestructive(e));
    const errors = events.filter((e) => e.type === "error");

    const issues: string[] = [];
    let severity: "info" | "warning" | "critical" = "info";

    if (hallucinations.length > 0) {
      issues.push(`Detected ${hallucinations.length} potential hallucination(s)`);
      severity = "warning";
    }

    if (destructive.length > 0) {
      issues.push(`Detected ${destructive.length} destructive command(s)`);
      severity = "critical";
    }

    if (errors.length > 5) {
      issues.push(`High error rate: ${errors.length} error(s)`);
      if (severity === "info") severity = "warning";
    }

    if (events.length > 100) {
      issues.push("Session exceeded 100 events - may indicate runaway loop");
      severity = "warning";
    }

    return {
      sessionId,
      startTime,
      endTime,
      duration: endTime - startTime,
      toolCallCount: events.filter((e) => e.type === "tool-call").length,
      hallucinations,
      destructiveCommands: destructive,
      errors,
      totalEvents: events.length,
      severity,
      issues,
    };
  }

  /**
   * Detect potential hallucinations
   */
  private static detectHallucination(event: AcpSessionEvent): boolean {
    if (event.type !== "message") {
      return false;
    }

    for (const pattern of HALLUCINATION_INDICATORS) {
      if (pattern.test(event.content)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect destructive commands
   */
  private static detectDestructive(event: AcpSessionEvent): boolean {
    if (event.type !== "tool-call") {
      return false;
    }

    const command = event.content || event.toolName || "";
    for (const pattern of DESTRUCTIVE_COMMANDS) {
      if (pattern.test(command)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Format summary for alerts/reporting
   */
  static formatSummary(summary: AcpAuditSummary): string {
    const lines: string[] = [];

    lines.push(`ACP Session Audit: ${summary.sessionId}`);
    lines.push(`Duration: ${Math.round(summary.duration / 1000)}s`);
    lines.push(`Events: ${summary.totalEvents} total, ${summary.toolCallCount} tool calls`);

    if (summary.issues.length > 0) {
      lines.push(`Severity: ${summary.severity.toUpperCase()}`);
      lines.push("Issues:");
      for (const issue of summary.issues) {
        lines.push(`  - ${issue}`);
      }
    }

    if (summary.destructiveCommands.length > 0) {
      lines.push("Destructive Commands:");
      for (const cmd of summary.destructiveCommands.slice(0, 3)) {
        lines.push(`  - ${cmd.toolName}: ${cmd.content.slice(0, 60)}...`);
      }
    }

    if (summary.hallucinations.length > 0) {
      lines.push("Hallucinations:");
      for (const hal of summary.hallucinations.slice(0, 3)) {
        lines.push(`  - ${hal.content.slice(0, 60)}...`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Determine if alert should be sent
   */
  static shouldAlert(summary: AcpAuditSummary): boolean {
    // Alert on critical severity or any destructive commands
    return summary.severity === "critical" || summary.destructiveCommands.length > 0;
  }
}
