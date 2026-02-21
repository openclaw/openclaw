/**
 * Execution Plan Governance Plugin for OpenClaw
 *
 * Simple approach:
 * 1. before_request: Call LLM with user message + schema → get execution plan
 * 2. before_tool_call: Validate tool call against plan's procedure
 *
 * The plan is the single source of truth.
 */

import type { PluginApi, PluginHookContext, PluginHookToolContext } from "@anthropic/plugin-sdk";

// ============================================================================
// Execution Plan Schema (from execution-plan.json)
// ============================================================================

interface ExecutionPlan {
  description_for_user: string;
  five_w_one_h: {
    who: string;
    what: string;
    where: string;
    when: string;
    why: string;
    how: string;
  };
  procedure: Array<{
    step: number;
    action: string;
  }>;
  surface_effects: {
    touches: string[];
    modifies: boolean;
    creates: boolean;
    deletes: boolean;
  };
  constraints: string[];
  execution_mode: "preview" | "execute";
}

// ============================================================================
// Plan Store
// ============================================================================

const planStore: Map<string, ExecutionPlan> = new Map();

// ============================================================================
// Config
// ============================================================================

interface ExecutionPlanConfig {
  enabled?: boolean;
  defaultMode?: "preview" | "execute";
  failOpen?: boolean;
}

// ============================================================================
// Planning Prompt
// ============================================================================

function buildPlanningPrompt(userMessage: string, defaultMode: "preview" | "execute"): string {
  return `...`;
}

// ============================================================================
// Plugin
// ============================================================================

export default function executionPlanGovernance(api: PluginApi): void {
  const config = (api.config ?? {}) as ExecutionPlanConfig;

  if (config.enabled === false) {
    return;
  }

  api.log?.info?.("[execution-plan] Plugin initialized");

  // -------------------------------------------------------------------------
  // before_request: Generate execution plan via LLM
  // -------------------------------------------------------------------------
  api.on("before_request", async (event, ctx: PluginHookContext) => {
    const runId = ctx.runId;
    if (!runId) return {};

    // Get user message
    const messages =
      (event as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMessage) return {};

    const userContent = lastUserMessage.content;

    // Build planning prompt
    const planningPrompt = buildPlanningPrompt(userContent, config.defaultMode ?? "preview");

    try {
      // Call LLM to generate plan
      // Note: This uses OpenClaw's internal completion API
      const planResponse = await api.completion?.({
        messages: [{ role: "user", content: planningPrompt }],
        max_tokens: 1024,
        temperature: 0,
      });

      if (!planResponse?.content) {
        throw new Error("No response from planning model");
      }

      // Parse plan
      const planText =
        typeof planResponse.content === "string"
          ? planResponse.content
          : (planResponse.content[0]?.text ?? "");

      const plan: ExecutionPlan = JSON.parse(planText.trim());

      // Store plan
      planStore.set(runId, plan);

      api.log?.info?.(`[execution-plan] Generated plan: ${plan.description_for_user}`);
      api.log?.debug?.(`[execution-plan] Procedure: ${plan.procedure.length} steps`);

      // If preview mode, inject plan into context and don't execute
      if (plan.execution_mode === "preview") {
        const previewMessage = `[Execution Plan - Preview Only]

${plan.description_for_user}

Steps:
${plan.procedure.map((p) => `${p.step}. ${p.action}`).join("\n")}

Effects: ${
          [
            plan.surface_effects.modifies && "modifies",
            plan.surface_effects.creates && "creates",
            plan.surface_effects.deletes && "deletes",
          ]
            .filter(Boolean)
            .join(", ") || "read-only"
        }

Touches: ${plan.surface_effects.touches.join(", ")}

Constraints: ${plan.constraints.join("; ") || "none"}

This is a preview. No actions will be executed. Reply to confirm or modify.`;

        return {
          block: true,
          blockReason: previewMessage,
        };
      }

      return {};
    } catch (error) {
      api.log?.error?.(`[execution-plan] Plan generation failed: ${error}`);

      if (config.failOpen) {
        return {};
      }

      return {
        block: true,
        blockReason: "Could not generate execution plan. Please rephrase your request.",
      };
    }
  });
}
