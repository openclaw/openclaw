/**
 * Syntropy Health tool definitions for the OpenClaw agent.
 *
 * Each tool wraps a Syntropy MCP tool, calling it via HTTP with the
 * user's stored API token (standard Bearer auth).
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TObject } from "@sinclair/typebox";
import { callSyntropyTool, type SyntropyToolResult } from "./client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAgentResult(res: SyntropyToolResult): AgentToolResult<unknown> {
  if (!res.ok) {
    return {
      content: [{ type: "text", text: `Error: ${res.error ?? "Unknown error"}` }],
      details: { error: res.error },
    };
  }
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
  return { content: [{ type: "text", text }], details: res.data };
}

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  mcpToolName: string;
}

// ---------------------------------------------------------------------------
// Tool definitions — 9 consumer tools
// ---------------------------------------------------------------------------

const TOOL_DEFS: ToolDef[] = [
  {
    name: "syntropy_log_food",
    label: "Log Food",
    mcpToolName: "log_food",
    description:
      "Log a food entry to the user's Syntropy health journal with optional macro breakdown.",
    parameters: Type.Object({
      food_name: Type.String({ description: "Food item name or description" }),
      meal_type: Type.Optional(Type.String({ description: "breakfast, lunch, dinner, or snack" })),
      calories: Type.Optional(Type.Number({ description: "Calories" })),
      protein: Type.Optional(Type.Number({ description: "Protein in grams" })),
      carbs: Type.Optional(Type.Number({ description: "Carbs in grams" })),
      fat: Type.Optional(Type.Number({ description: "Fat in grams" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
    }),
  },
  {
    name: "syntropy_log_checkin",
    label: "Health Check-in",
    mcpToolName: "log_checkin",
    description:
      "Record a daily health check-in. Describe how you feel, symptoms, medications, or wellness notes.",
    parameters: Type.Object({
      content: Type.String({ description: "Free-text health check-in" }),
    }),
  },
  {
    name: "syntropy_chat",
    label: "Chat with Shrine",
    mcpToolName: "chat_with_shrine",
    description:
      "Chat with ShrineAI, the user's personal health AI assistant. Remembers conversation history.",
    parameters: Type.Object({
      message: Type.String({ description: "Message to send to ShrineAI" }),
      session_id: Type.Optional(Type.String({ description: "Session ID for continuity" })),
    }),
  },
  {
    name: "syntropy_diet_score",
    label: "Diet Score",
    mcpToolName: "get_diet_score",
    description: "Get diet fulfillment score (0-100) over the last N days with breakdown.",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Days to score (default: 30, max: 365)" })),
    }),
  },
  {
    name: "syntropy_diet_gap",
    label: "Diet Gap Analysis",
    mcpToolName: "get_diet_gap",
    description: "Compare actual macro intake vs ideal targets (protein, carbs, fat, calories).",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Days to analyze (default: 7, max: 365)" })),
    }),
  },
  {
    name: "syntropy_health_snapshot",
    label: "Health Snapshot",
    mcpToolName: "get_health_snapshot",
    description: "Aggregated health snapshot: food logs, symptoms, medications, macro totals.",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Days (default: 30, max: 365)" })),
    }),
  },
  {
    name: "syntropy_analyze_food",
    label: "Analyze Food",
    mcpToolName: "analyze_food",
    description:
      "Parse natural language food description into structured entries with macro totals.",
    parameters: Type.Object({
      food_text: Type.String({ description: "Natural language food description" }),
      meal_type: Type.Optional(Type.String({ description: "breakfast, lunch, dinner, or snack" })),
    }),
  },
  {
    name: "syntropy_health_profile",
    label: "Health Profile",
    mcpToolName: "get_health_profile",
    description:
      "Get health profile: dietary preferences, goals, conditions, allergies, supplements.",
    parameters: Type.Object({}),
  },
  {
    name: "syntropy_my_checkins",
    label: "Recent Check-ins",
    mcpToolName: "get_my_checkins",
    description: "Get recent health check-ins.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Count (default: 10, max: 50)" })),
    }),
  },
];

// ---------------------------------------------------------------------------
// Factory — creates tools bound to a specific user's auth token
// ---------------------------------------------------------------------------

export function createAllTools(
  baseUrl: string,
  authToken: string,
): Array<{
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  execute: (toolCallId: string, args: unknown) => Promise<AgentToolResult<unknown>>;
}> {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
      const params = (args ?? {}) as Record<string, unknown>;
      const result = await callSyntropyTool(baseUrl, authToken, def.mcpToolName, params);
      return toAgentResult(result);
    },
  }));
}
