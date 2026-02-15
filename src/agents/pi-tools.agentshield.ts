import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult } from "./tools/common.js";

type AgentShieldContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Feature gate: entirely disabled unless AGENTSHIELD_APPROVALS_ENABLED=1.
 */
function isEnabled(): boolean {
  return process.env.AGENTSHIELD_APPROVALS_ENABLED === "1";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produce canonical JSON for a params value (never logged — only hashed).
 */
function canonicalParamsJSON(params: unknown): string {
  if (params === undefined || params === null) {
    return "{}";
  }
  if (typeof params === "string") {
    return JSON.stringify(params);
  }
  return JSON.stringify(params, Object.keys(isPlainObject(params) ? params : {}).toSorted());
}

/**
 * Inspect a tool result for an AgentShield "needs-approval" signal.
 *
 * The convention is: if the result's `details` (or parsed content text)
 * contains `action: "needs_approval"` or `action: "needs-approval"`,
 * the call requires operator approval before proceeding.
 */
function needsApproval(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const r = result as Record<string, unknown>;

  // Check details field (structured payload).
  const details = r.details;
  if (isPlainObject(details)) {
    const action = details.action;
    if (action === "needs_approval" || action === "needs-approval") {
      return true;
    }
  }

  // Check content array for text with approval indicator.
  const content = r.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isPlainObject(item) && typeof item.text === "string") {
        try {
          const parsed = JSON.parse(item.text);
          if (isPlainObject(parsed)) {
            const action = parsed.action;
            if (action === "needs_approval" || action === "needs-approval") {
              return true;
            }
          }
        } catch {
          // Not JSON — ignore.
        }
      }
    }
  }

  return false;
}

/**
 * Wrap a tool so that when AgentShield flags it with "needs-approval",
 * the wrapper returns an `approval-pending` result immediately instead
 * of the original result.
 *
 * The caller (gateway handler) is responsible for storing encrypted args
 * and sending the approval request over the gateway protocol.
 */
export function wrapToolWithAgentShieldApproval(
  tool: AnyAgentTool,
  ctx?: AgentShieldContext,
): AnyAgentTool {
  if (!isEnabled()) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await execute(toolCallId, params, signal, onUpdate);

      if (!needsApproval(result)) {
        return result;
      }

      // Produce canonical JSON once — used for both fingerprint and retry store.
      const paramsJSON = canonicalParamsJSON(params);

      return jsonResult({
        status: "approval-pending",
        tool: toolName,
        paramsJSON,
        agentId: ctx?.agentId ?? null,
        sessionKey: ctx?.sessionKey ?? null,
        message: "Tool call requires AgentShield approval. Awaiting operator decision.",
      });
    },
  };
}

export const __testing = {
  isEnabled,
  needsApproval,
  canonicalParamsJSON,
};
