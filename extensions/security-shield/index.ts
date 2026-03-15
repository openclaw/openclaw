/**
 * Security Shield plugin for OpenClaw.
 *
 * Registers before_tool_call and after_tool_call hooks to:
 * 1. Block dangerous commands (rm -rf, curl|bash, reverse shells, etc.)
 * 2. Detect and redact secret leaks in tool output (API keys, tokens, etc.)
 * 3. Log all tool activity to an audit trail
 *
 * Works with all existing tools and extensions — no code changes required.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeAuditEntry, type AuditEntry } from "./src/audit-log.js";
import { scanForDangerousCommands } from "./src/dangerous-commands.js";
import { scanForLeaks, redactLeaks } from "./src/leak-detector.js";

type ShieldConfig = {
  enforcement?: "block" | "warn" | "off";
  auditLog?: boolean;
  leakDetection?: boolean;
};

function resolveConfig(raw?: Record<string, unknown>): ShieldConfig {
  return {
    enforcement: (raw?.enforcement as ShieldConfig["enforcement"]) ?? "block",
    auditLog: raw?.auditLog !== false,
    leakDetection: raw?.leakDetection !== false,
  };
}

const plugin = {
  id: "security-shield",
  name: "Security Shield",
  description:
    "Blocks dangerous tool commands, detects secret leaks in tool output, and logs all tool activity.",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      enforcement: { type: "string" as const, enum: ["block", "warn", "off"], default: "block" },
      auditLog: { type: "boolean" as const, default: true },
      leakDetection: { type: "boolean" as const, default: true },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

    logger.info(
      `Security Shield active (enforcement=${config.enforcement}, leakDetection=${config.leakDetection}, auditLog=${config.auditLog})`,
    );

    // ── before_tool_call: block dangerous commands ──────────────
    // Note: scans stringified params broadly. Only "critical" severity
    // rules trigger blocking to reduce false positives from text fields.
    api.on("before_tool_call", (event) => {
      if (config.enforcement === "off") return;

      const paramsStr = JSON.stringify(event.params ?? {});
      const matches = scanForDangerousCommands(paramsStr);

      if (matches.length === 0) return;

      const criticals = matches.filter((m) => m.severity === "critical");

      // Log all findings
      for (const m of matches) {
        const logMsg = `[Security Shield] ${m.severity.toUpperCase()}: ${m.message} (${m.ruleId}) in tool '${event.toolName}' — evidence: ${m.evidence}`;
        if (m.severity === "critical") {
          logger.warn(logMsg);
        } else {
          logger.info(logMsg);
        }
      }

      // Audit log (redact params to avoid writing secrets to disk)
      if (config.auditLog) {
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          params: redactLeaks(paramsStr),
          blocked: config.enforcement === "block" && criticals.length > 0,
          blockReason:
            criticals.length > 0 ? criticals.map((m) => m.message).join("; ") : undefined,
          findings: matches.map((m) => ({
            ruleId: m.ruleId,
            severity: m.severity,
            message: m.message,
          })),
        });
      }

      // Block critical matches in block mode
      if (config.enforcement === "block" && criticals.length > 0) {
        const reasons = criticals.map((m) => `• ${m.message} (${m.ruleId})`).join("\n");
        return {
          block: true,
          blockReason: `🛡️ Security Shield blocked this tool call:\n${reasons}\n\nIf this is intentional, ask the user to confirm.`,
        };
      }
    });

    // ── after_tool_call: log leaks + audit trail (observational) ─
    // Note: after_tool_call is fire-and-forget (void hook), so we cannot
    // modify event.result here. Actual redaction happens in message_sending.
    // A future tool_result_persist hook would allow redaction before
    // transcript storage — see openclaw hook docs for updates.
    api.on("after_tool_call", (event) => {
      const resultStr = event.result != null ? JSON.stringify(event.result) : "";
      const findings: AuditEntry["findings"] = [];

      // Detect leaks for logging and audit purposes
      if (config.leakDetection && resultStr.length > 0) {
        const leaks = scanForLeaks(resultStr);

        for (const leak of leaks) {
          logger.warn(
            `[Security Shield] LEAK DETECTED: ${leak.message} (${leak.ruleId}) in output of '${event.toolName}' — ${leak.evidence}`,
          );
          findings.push({
            ruleId: leak.ruleId,
            message: leak.message,
          });
        }
      }

      // Audit log (redact params to avoid writing secrets to disk)
      if (config.auditLog) {
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          params: redactLeaks(JSON.stringify(event.params ?? {})),
          blocked: false,
          findings,
          durationMs: event.durationMs,
          error: event.error ? redactLeaks(event.error) : undefined,
        });
      }
    });

    // ── message_sending: redact leaks in outbound messages ──────
    api.on("message_sending", (event) => {
      if (!config.leakDetection) return;

      const leaks = scanForLeaks(event.content);
      if (leaks.length === 0) return;

      for (const leak of leaks) {
        logger.warn(
          `[Security Shield] Redacting ${leak.message} (${leak.ruleId}) from outbound message`,
        );
      }

      return {
        content: redactLeaks(event.content),
      };
    });
  },
};

export default plugin;
