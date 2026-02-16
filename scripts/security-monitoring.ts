#!/usr/bin/env node --import tsx
/**
 * OpenClaw Security Monitoring System
 * Automated security metrics collection and alerting
 *
 * Usage:
 *   node --import tsx scripts/security-monitoring.ts
 *   node --import tsx scripts/security-monitoring.ts --once
 *   node --import tsx scripts/security-monitoring.ts --alert-only
 */

import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

// Configuration
const CONFIG = {
  // Log file locations
  logs: {
    security: process.env.SECURITY_LOG || "/var/log/openclaw/security.log",
    application: process.env.APP_LOG || "/var/log/openclaw/application.log",
    access: process.env.ACCESS_LOG || "/var/log/openclaw/access.log",
  },

  // Monitoring intervals
  intervals: {
    metrics: 60000, // Collect metrics every 60 seconds
    alerts: 300000, // Check alerts every 5 minutes
  },

  // Alert thresholds
  thresholds: {
    sandboxViolations: {
      warning: 5, // per hour
      critical: 20, // per hour
    },
    rateLimit: {
      warning: 50, // per hour
      critical: 200, // per hour
    },
    authFailures: {
      warning: 20, // per hour
      critical: 100, // per hour
    },
    signatureFailures: {
      warning: 5, // per hour
      critical: 20, // per hour
    },
    csrfTriggers: {
      warning: 10, // per hour
      critical: 50, // per hour
    },
  },

  // Alert destinations
  alerts: {
    email: process.env.ALERT_EMAIL || "security-team@example.com",
    slack: process.env.SLACK_WEBHOOK || "",
    pagerduty: process.env.PAGERDUTY_KEY || "",
  },

  // Metrics storage
  metricsDir: process.env.METRICS_DIR || "/tmp/openclaw-metrics",
};

// Interfaces
interface SecurityMetrics {
  timestamp: Date;
  sandboxViolations: number;
  rateLimitTriggers: number;
  authFailures: number;
  signatureFailures: number;
  csrfTriggers: number;
  registryTampering: number;
  pluginLoadErrors: number;
}

interface Alert {
  severity: "warning" | "critical";
  type: string;
  message: string;
  value: number;
  threshold: number;
  timestamp: Date;
}

// Utility functions
function log(message: string, level: "info" | "warn" | "error" = "info") {
  const timestamp = new Date().toISOString();
  const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️ " : "✓ ";
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

async function readLogLines(logFile: string, since: Date): Promise<string[]> {
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split("\n");

    return lines.filter((line) => {
      if (!line) {
        return false;
      }

      // Extract timestamp from log line (format may vary)
      const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2})/);
      if (!timestampMatch) {
        return false;
      }

      const lineTime = new Date(timestampMatch[1]);
      return lineTime >= since;
    });
  } catch (error) {
    log(`Error reading log file ${logFile}: ${error}`, "warn");
    return [];
  }
}

function countPattern(lines: string[], pattern: string | RegExp): number {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  return lines.filter((line) => regex.test(line)).length;
}

// Metrics collection
async function collectSecurityMetrics(): Promise<SecurityMetrics> {
  const oneHourAgo = new Date(Date.now() - 3600000);
  const securityLines = await readLogLines(CONFIG.logs.security, oneHourAgo);

  return {
    timestamp: new Date(),
    sandboxViolations: countPattern(securityLines, /sandbox_violation/),
    rateLimitTriggers: countPattern(securityLines, /rate_limit_exceeded/),
    authFailures: countPattern(securityLines, /authentication_failure/),
    signatureFailures: countPattern(securityLines, /signature_verification_failure/),
    csrfTriggers: countPattern(securityLines, /csrf_protection_triggered/),
    registryTampering: countPattern(securityLines, /registry_tampering_attempt/),
    pluginLoadErrors: countPattern(securityLines, /plugin_load_error/),
  };
}

// Alert generation
function checkThresholds(metrics: SecurityMetrics): Alert[] {
  const alerts: Alert[] = [];

  // Check sandbox violations
  if (metrics.sandboxViolations >= CONFIG.thresholds.sandboxViolations.critical) {
    alerts.push({
      severity: "critical",
      type: "sandbox_violations",
      message: `CRITICAL: ${metrics.sandboxViolations} sandbox violations in last hour`,
      value: metrics.sandboxViolations,
      threshold: CONFIG.thresholds.sandboxViolations.critical,
      timestamp: new Date(),
    });
  } else if (metrics.sandboxViolations >= CONFIG.thresholds.sandboxViolations.warning) {
    alerts.push({
      severity: "warning",
      type: "sandbox_violations",
      message: `WARNING: ${metrics.sandboxViolations} sandbox violations in last hour`,
      value: metrics.sandboxViolations,
      threshold: CONFIG.thresholds.sandboxViolations.warning,
      timestamp: new Date(),
    });
  }

  // Check rate limiting
  if (metrics.rateLimitTriggers >= CONFIG.thresholds.rateLimit.critical) {
    alerts.push({
      severity: "critical",
      type: "rate_limit",
      message: `CRITICAL: ${metrics.rateLimitTriggers} rate limit triggers (possible DDoS)`,
      value: metrics.rateLimitTriggers,
      threshold: CONFIG.thresholds.rateLimit.critical,
      timestamp: new Date(),
    });
  } else if (metrics.rateLimitTriggers >= CONFIG.thresholds.rateLimit.warning) {
    alerts.push({
      severity: "warning",
      type: "rate_limit",
      message: `WARNING: ${metrics.rateLimitTriggers} rate limit triggers`,
      value: metrics.rateLimitTriggers,
      threshold: CONFIG.thresholds.rateLimit.warning,
      timestamp: new Date(),
    });
  }

  // Check authentication failures
  if (metrics.authFailures >= CONFIG.thresholds.authFailures.critical) {
    alerts.push({
      severity: "critical",
      type: "auth_failures",
      message: `CRITICAL: ${metrics.authFailures} authentication failures (possible brute force)`,
      value: metrics.authFailures,
      threshold: CONFIG.thresholds.authFailures.critical,
      timestamp: new Date(),
    });
  } else if (metrics.authFailures >= CONFIG.thresholds.authFailures.warning) {
    alerts.push({
      severity: "warning",
      type: "auth_failures",
      message: `WARNING: ${metrics.authFailures} authentication failures`,
      value: metrics.authFailures,
      threshold: CONFIG.thresholds.authFailures.warning,
      timestamp: new Date(),
    });
  }

  // Check signature failures
  if (metrics.signatureFailures >= CONFIG.thresholds.signatureFailures.critical) {
    alerts.push({
      severity: "critical",
      type: "signature_failures",
      message: `CRITICAL: ${metrics.signatureFailures} signature verification failures`,
      value: metrics.signatureFailures,
      threshold: CONFIG.thresholds.signatureFailures.critical,
      timestamp: new Date(),
    });
  } else if (metrics.signatureFailures >= CONFIG.thresholds.signatureFailures.warning) {
    alerts.push({
      severity: "warning",
      type: "signature_failures",
      message: `WARNING: ${metrics.signatureFailures} signature verification failures`,
      value: metrics.signatureFailures,
      threshold: CONFIG.thresholds.signatureFailures.warning,
      timestamp: new Date(),
    });
  }

  // Check CSRF triggers
  if (metrics.csrfTriggers >= CONFIG.thresholds.csrfTriggers.critical) {
    alerts.push({
      severity: "critical",
      type: "csrf_triggers",
      message: `CRITICAL: ${metrics.csrfTriggers} CSRF protection triggers`,
      value: metrics.csrfTriggers,
      threshold: CONFIG.thresholds.csrfTriggers.critical,
      timestamp: new Date(),
    });
  } else if (metrics.csrfTriggers >= CONFIG.thresholds.csrfTriggers.warning) {
    alerts.push({
      severity: "warning",
      type: "csrf_triggers",
      message: `WARNING: ${metrics.csrfTriggers} CSRF protection triggers`,
      value: metrics.csrfTriggers,
      threshold: CONFIG.thresholds.csrfTriggers.warning,
      timestamp: new Date(),
    });
  }

  // Registry tampering (any attempt is critical)
  if (metrics.registryTampering > 0) {
    alerts.push({
      severity: "critical",
      type: "registry_tampering",
      message: `CRITICAL: ${metrics.registryTampering} registry tampering attempts detected!`,
      value: metrics.registryTampering,
      threshold: 0,
      timestamp: new Date(),
    });
  }

  return alerts;
}

// Alert delivery
async function sendAlert(alert: Alert): Promise<void> {
  log(
    `Alert: ${alert.severity.toUpperCase()} - ${alert.message}`,
    alert.severity === "critical" ? "error" : "warn",
  );

  // Email alert
  if (CONFIG.alerts.email) {
    try {
      const subject = `OpenClaw Security Alert: ${alert.severity.toUpperCase()} - ${alert.type}`;
      const body = `
${alert.message}

Details:
- Type: ${alert.type}
- Severity: ${alert.severity}
- Value: ${alert.value}
- Threshold: ${alert.threshold}
- Timestamp: ${alert.timestamp.toISOString()}

Action Required:
1. Review security logs: /var/log/openclaw/security.log
2. Check monitoring dashboard
3. Follow incident response playbook if needed

View logs:
  tail -n 100 /var/log/openclaw/security.log | grep ${alert.type}

OpenClaw Security Monitoring System
      `;

      await execAsync(`echo "${body}" | mail -s "${subject}" ${CONFIG.alerts.email}`);
      log(`Email alert sent to ${CONFIG.alerts.email}`);
    } catch (error) {
      log(`Failed to send email alert: ${error}`, "error");
    }
  }

  // Slack alert
  if (CONFIG.alerts.slack) {
    try {
      const payload = {
        text: `🚨 *${alert.severity.toUpperCase()}*: ${alert.message}`,
        attachments: [
          {
            color: alert.severity === "critical" ? "danger" : "warning",
            fields: [
              { title: "Type", value: alert.type, short: true },
              { title: "Value", value: alert.value.toString(), short: true },
              { title: "Threshold", value: alert.threshold.toString(), short: true },
              { title: "Time", value: alert.timestamp.toISOString(), short: true },
            ],
          },
        ],
      };

      await execAsync(
        `curl -X POST -H 'Content-type: application/json' --data '${JSON.stringify(payload)}' ${CONFIG.alerts.slack}`,
      );
      log("Slack alert sent");
    } catch (error) {
      log(`Failed to send Slack alert: ${error}`, "error");
    }
  }

  // PagerDuty alert (for critical only)
  if (CONFIG.alerts.pagerduty && alert.severity === "critical") {
    try {
      const payload = {
        routing_key: CONFIG.alerts.pagerduty,
        event_action: "trigger",
        payload: {
          summary: alert.message,
          severity: "critical",
          source: "openclaw-security-monitor",
          custom_details: {
            type: alert.type,
            value: alert.value,
            threshold: alert.threshold,
          },
        },
      };

      await execAsync(
        `curl -X POST -H 'Content-type: application/json' --data '${JSON.stringify(payload)}' https://events.pagerduty.com/v2/enqueue`,
      );
      log("PagerDuty alert sent");
    } catch (error) {
      log(`Failed to send PagerDuty alert: ${error}`, "error");
    }
  }
}

// Metrics storage
function saveMetrics(metrics: SecurityMetrics): void {
  try {
    // Ensure metrics directory exists
    if (!fs.existsSync(CONFIG.metricsDir)) {
      fs.mkdirSync(CONFIG.metricsDir, { recursive: true });
    }

    // Save to daily file
    const date = metrics.timestamp.toISOString().split("T")[0];
    const metricsFile = path.join(CONFIG.metricsDir, `metrics-${date}.jsonl`);

    fs.appendFileSync(metricsFile, JSON.stringify(metrics) + "\n");
    log(`Metrics saved to ${metricsFile}`);
  } catch (error) {
    log(`Error saving metrics: ${error}`, "error");
  }
}

// Generate report
function generateDailyReport(): string {
  const today = new Date().toISOString().split("T")[0];
  const metricsFile = path.join(CONFIG.metricsDir, `metrics-${today}.jsonl`);

  if (!fs.existsSync(metricsFile)) {
    return "No metrics available for today";
  }

  const lines = fs
    .readFileSync(metricsFile, "utf-8")
    .split("\n")
    .filter((line) => line);
  const metrics = lines.map((line) => JSON.parse(line) as SecurityMetrics);

  const totals = metrics.reduce(
    (acc, m) => ({
      sandboxViolations: acc.sandboxViolations + m.sandboxViolations,
      rateLimitTriggers: acc.rateLimitTriggers + m.rateLimitTriggers,
      authFailures: acc.authFailures + m.authFailures,
      signatureFailures: acc.signatureFailures + m.signatureFailures,
      csrfTriggers: acc.csrfTriggers + m.csrfTriggers,
      registryTampering: acc.registryTampering + m.registryTampering,
      pluginLoadErrors: acc.pluginLoadErrors + m.pluginLoadErrors,
    }),
    {
      sandboxViolations: 0,
      rateLimitTriggers: 0,
      authFailures: 0,
      signatureFailures: 0,
      csrfTriggers: 0,
      registryTampering: 0,
      pluginLoadErrors: 0,
    },
  );

  return `
OpenClaw Security Report - ${today}

Metrics collected: ${metrics.length} samples

Total Events:
  - Sandbox Violations: ${totals.sandboxViolations}
  - Rate Limit Triggers: ${totals.rateLimitTriggers}
  - Authentication Failures: ${totals.authFailures}
  - Signature Failures: ${totals.signatureFailures}
  - CSRF Triggers: ${totals.csrfTriggers}
  - Registry Tampering: ${totals.registryTampering}
  - Plugin Load Errors: ${totals.pluginLoadErrors}

Status:
  ${totals.sandboxViolations === 0 && totals.registryTampering === 0 ? "✓ No security incidents" : "⚠️  Security events detected"}
  ${totals.rateLimitTriggers < 100 ? "✓ Rate limiting normal" : "⚠️  High rate limiting activity"}
  ${totals.authFailures < 50 ? "✓ Authentication normal" : "⚠️  High authentication failures"}
  ${totals.signatureFailures === 0 ? "✓ All plugins signed" : "⚠️  Signature verification issues"}
  `;
}

// Main monitoring loop
async function monitorSecurityMetrics(): Promise<void> {
  log("Starting security monitoring...");

  const collectAndCheck = async () => {
    try {
      // Collect metrics
      log("Collecting security metrics...");
      const metrics = await collectSecurityMetrics();

      // Save metrics
      saveMetrics(metrics);

      // Check for alerts
      const alerts = checkThresholds(metrics);

      if (alerts.length > 0) {
        log(`Found ${alerts.length} alert(s)`, "warn");
        for (const alert of alerts) {
          await sendAlert(alert);
        }
      } else {
        log("No alerts triggered");
      }

      // Log metrics summary
      log(
        `Metrics: sandbox=${metrics.sandboxViolations}, rate_limit=${metrics.rateLimitTriggers}, auth=${metrics.authFailures}, sig=${metrics.signatureFailures}`,
      );
    } catch (error) {
      log(`Error in monitoring cycle: ${error}`, "error");
    }
  };

  // Initial check
  await collectAndCheck();

  // Set up intervals
  setInterval(collectAndCheck, CONFIG.intervals.metrics);

  // Daily report
  setInterval(() => {
    const report = generateDailyReport();
    log("Daily security report generated");
    console.log(report);
  }, 86400000); // 24 hours
}

// CLI handling
async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has("--help")) {
    console.log(`
OpenClaw Security Monitoring System

Usage:
  node --import tsx scripts/security-monitoring.ts [options]

Options:
  --once        Run once and exit
  --report      Generate daily report and exit
  --alert-only  Check alerts only, don't save metrics
  --help        Show this help

Environment Variables:
  SECURITY_LOG     Path to security log file
  APP_LOG          Path to application log file
  ACCESS_LOG       Path to access log file
  METRICS_DIR      Directory to store metrics
  ALERT_EMAIL      Email address for alerts
  SLACK_WEBHOOK    Slack webhook URL
  PAGERDUTY_KEY    PagerDuty routing key
    `);
    return;
  }

  if (args.has("--report")) {
    const report = generateDailyReport();
    console.log(report);
    return;
  }

  if (args.has("--once")) {
    log("Running single security check...");
    const metrics = await collectSecurityMetrics();
    saveMetrics(metrics);
    const alerts = checkThresholds(metrics);

    console.log("\nCurrent Metrics:");
    console.log(JSON.stringify(metrics, null, 2));

    if (alerts.length > 0) {
      console.log(`\nAlerts (${alerts.length}):`);
      alerts.forEach((alert) => console.log(`  ${alert.severity}: ${alert.message}`));

      if (!args.has("--no-send")) {
        for (const alert of alerts) {
          await sendAlert(alert);
        }
      }
    } else {
      console.log("\n✓ No alerts");
    }

    return;
  }

  if (args.has("--alert-only")) {
    const metrics = await collectSecurityMetrics();
    const alerts = checkThresholds(metrics);

    if (alerts.length > 0) {
      for (const alert of alerts) {
        await sendAlert(alert);
      }
    }

    return;
  }

  // Default: run monitoring loop
  await monitorSecurityMetrics();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
