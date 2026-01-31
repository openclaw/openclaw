/**
 * Tool Execution Guard
 *
 * Validates that tool invocations match their promised capabilities.
 * Prevents misuse of tools for things they cannot do.
 *
 * Runs BEFORE tool is executed.
 */

import { TOOL_CAPABILITIES } from "../tool-capabilities.js";

export interface ToolExecutionGuardResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

/**
 * Guard configuration - what to prevent
 */
const EXECUTION_GUARDS = {
  message: {
    // Detect: "message tool to monitor for event X"
    preventPatterns: [
      {
        check: (args: Record<string, unknown>) => {
          const message = String(args.message || "").toLowerCase();
          return (
            message.includes("notify you when") ||
            message.includes("message you when") ||
            message.includes("alert you when")
          );
        },
        reason:
          "Cannot use message tool to send conditional notifications (requires cron job setup first)",
      },
    ],
  },

  exec: {
    preventPatterns: [
      {
        check: (args: Record<string, unknown>) => {
          const command = String(args.command || "").toLowerCase();
          return (
            command.includes("daemon") ||
            command.includes("&") ||
            command.includes("nohup") ||
            command.includes("background")
          );
        },
        reason:
          "Backgrounding processes is not reliable in exec tool (they terminate with session)",
      },
    ],
  },

  browser: {
    preventPatterns: [
      {
        check: (args: Record<string, unknown>) => {
          const interval = Number(args.interval) || Number(args.pollingInterval) || 0;
          return interval > 0;
        },
        reason:
          "Browser tool cannot handle polling/continuous monitoring (would require external scheduler)",
      },
    ],
  },
};

/**
 * Guard tool execution before it runs
 */
export function guardToolExecution(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentPromise?: string; // What did the agent claim it would do?
}): ToolExecutionGuardResult {
  const toolName = params.toolName.toLowerCase();
  const guards = EXECUTION_GUARDS[toolName as keyof typeof EXECUTION_GUARDS];

  if (!guards) {
    return { allowed: true };
  }

  // Check prevention patterns
  for (const pattern of guards.preventPatterns) {
    if (pattern.check(params.toolArgs)) {
      return {
        allowed: false,
        reason: pattern.reason,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate tool result matches what was promised
 */
export function validateToolResult(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: unknown;
  agentPromise?: string;
}): { valid: boolean; warning?: string } {
  // Example: if agent said "I'll monitor for changes" but exec only ran once
  // then the promise was not fulfilled

  if (params.toolName.toLowerCase() === "exec") {
    const command = String(params.toolArgs.command || "").toLowerCase();
    const promiseText = (params.agentPromise || "").toLowerCase();

    // If agent promised monitoring but only ran command once
    if (
      (promiseText.includes("monitor") || promiseText.includes("watch")) &&
      !command.includes("watch") &&
      !command.includes("tail") &&
      !command.includes("loop")
    ) {
      return {
        valid: false,
        warning:
          "Agent promised monitoring but exec only ran once. Promise not fulfilled. Consider cron for periodic checks.",
      };
    }
  }

  return { valid: true };
}

/**
 * Format guard rejection for user
 */
export function formatGuardRejection(result: ToolExecutionGuardResult): string {
  return `⚠️ Tool execution blocked: ${result.reason || "Guard prevented execution"}`;
}

/**
 * Check if tool scope matches usage context
 */
export function checkToolScope(params: {
  toolName: string;
  context: "reactive" | "synchronous" | "scheduled";
}): { matches: boolean; warning?: string } {
  const tool = TOOL_CAPABILITIES[params.toolName.toLowerCase()];
  if (!tool) return { matches: true };

  const scopeOk = {
    reactive: tool.scope === "reactive",
    synchronous: tool.scope === "synchronous",
    scheduled: tool.scope === "persistent",
  };

  if (!scopeOk[params.context]) {
    return {
      matches: false,
      warning: `Tool ${params.toolName} has scope "${tool.scope}" but is being used in "${params.context}" context`,
    };
  }

  return { matches: true };
}
