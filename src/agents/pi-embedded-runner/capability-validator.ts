/**
 * Capability Validator
 *
 * Validates that a model's promised actions are actually achievable
 * with the available tools and their constraints.
 *
 * Runs BEFORE response is sent to user to catch impossible promises early.
 */

import { TOOL_CAPABILITIES, canPromise, getNegativePromises } from "../tool-capabilities.js";

export interface CapabilityValidationIssue {
  type: "impossible_promise" | "missing_tool" | "wrong_scope" | "requires_setup";
  toolName?: string;
  promiseType?: string;
  message: string;
  suggestedFix: string;
}

export interface CapabilityValidationResult {
  isValid: boolean;
  issues: CapabilityValidationIssue[];
}

/**
 * Patterns that indicate impossible promises
 */
const IMPOSSIBLE_PROMISE_PATTERNS = [
  {
    pattern: /message.*when.*(?:online|back|online|startup|restart|reboot)/i,
    toolName: "message",
    promiseType: "message_when_system_online",
    message: "Cannot promise to message when system comes online (message tool is reactive-only)",
    fix: 'Use cron job instead: "I can set up a cron job to check and notify you when ready"',
  },
  {
    pattern: /message.*(?:event|happen|trigger|fire|detect)/i,
    toolName: "message",
    promiseType: "message_on_event",
    message: "Cannot promise to message on external events (message tool cannot monitor events)",
    fix: 'Consider alternative: "I can check periodically if you set up a cron job" or "I can respond immediately when you ask"',
  },
  {
    pattern: /monitor.*background/i,
    toolName: "exec",
    promiseType: "background_monitoring",
    message:
      "Cannot promise background monitoring with exec (processes terminate when session ends)",
    fix: 'Use cron instead: "I can set up a cron job to check periodically"',
  },
  {
    pattern: /(?:run|spawn|start).*(?:background|daemon|service|process)/i,
    toolName: "exec",
    promiseType: "start_daemon",
    message: "Cannot spawn persistent background processes (exec runs only during this session)",
    fix: 'Either: (1) Run it now and show output, or (2) Create a cron job for periodic execution"',
  },
  {
    pattern: /watch.*(?:file|directory|folder|path)/i,
    toolName: "exec",
    promiseType: "watch_file",
    message: "Cannot watch files continuously (exec cannot hook into system events)",
    fix: 'Alternative: "I can check the file now" or "Set up a cron job to check periodically"',
  },
  {
    pattern: /(?:monitor|track|watch).*(?:website|page|url)/i,
    toolName: "browser",
    promiseType: "continuous_monitoring",
    message: "Cannot monitor websites continuously (browser cannot auto-refresh)",
    fix: 'Alternatives: (1) Check now and show state, or (2) Create cron job to check periodically"',
  },
  {
    pattern: /the moment(?:\s+you|\s+it|\s+when)/i,
    toolName: "message",
    promiseType: "message_when_system_online",
    message: "Cannot promise immediate notification on external event (requires active monitoring)",
    fix: 'Be honest: "I cannot monitor. But I CAN: [alternatives]"',
  },
];

/**
 * Validate that a response does not contain impossible promises
 */
export function validateResponseCapabilities(
  modelResponse: string,
  availableTools: Set<string>,
): CapabilityValidationResult {
  const issues: CapabilityValidationIssue[] = [];

  // Pattern-based detection
  for (const { pattern, toolName, promiseType, message, fix } of IMPOSSIBLE_PROMISE_PATTERNS) {
    if (pattern.test(modelResponse)) {
      const hasToolAvailable = availableTools.has(toolName);

      if (!hasToolAvailable) {
        issues.push({
          type: "missing_tool",
          toolName,
          promiseType,
          message: `${message} (${toolName} tool not available)`,
          suggestedFix: fix,
        });
      } else if (!canPromise(toolName, promiseType || "")) {
        issues.push({
          type: "impossible_promise",
          toolName,
          promiseType,
          message,
          suggestedFix: fix,
        });
      }
    }
  }

  // Heuristic: Check for "Got it!" followed by promissory language
  if (/Got it|Understood|Will do|I will|I\'ll|Can do|No problem/i.test(modelResponse)) {
    const hasAnyPromise =
      /(?:message|monitor|watch|check|notify|alert).*(?:when|if|once|after)/i.test(modelResponse);
    const hasBackground = /(?:background|daemon|continuously|periodically|ongoing)/i.test(
      modelResponse,
    );

    if (hasAnyPromise || hasBackground) {
      // Flag for manual review; this is uncertain
      // Don't auto-reject, but log a warning
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}

/**
 * Format validation issues for the model to read and self-correct
 */
export function formatValidationIssuesForModel(issues: CapabilityValidationIssue[]): string {
  if (issues.length === 0) return "";

  const lines = [
    "⚠️ **Capability Validation Issues Detected:**",
    "",
    "Your response contains promises that cannot be fulfilled with available tools:",
    "",
  ];

  for (const issue of issues) {
    lines.push(`- **[${issue.type}]** ${issue.message}`);
    lines.push(`  Fix: ${issue.suggestedFix}`);
    lines.push("");
  }

  lines.push(
    "Please revise your response to remove impossible promises and suggest realistic alternatives.",
  );

  return lines.join("\n");
}

/**
 * Check if response mentions tool by name
 */
function mentionsTool(response: string, toolName: string): boolean {
  const regex = new RegExp(`\\b${toolName}\\b`, "i");
  return regex.test(response);
}

/**
 * Check if response contains event-driven language
 */
function mentionsEventDriven(response: string): boolean {
  return /(?:when|if|once|as soon as|the moment|upon|trigger|event|happen|fire|detect)/i.test(
    response,
  );
}

/**
 * Log validation for debugging (integrate with agent logger)
 */
export function logCapabilityValidation(
  validationResult: CapabilityValidationResult,
  agentLogger?: {
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  },
): void {
  if (agentLogger?.warn && validationResult.issues.length > 0) {
    const summary = validationResult.issues
      .map((i) => `${i.toolName}/${i.promiseType}: ${i.message}`)
      .join("; ");
    agentLogger.warn(`Capability validation: ${summary}`);
  }
}
