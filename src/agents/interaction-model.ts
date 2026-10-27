import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentEntry } from "./agent-scope-config.js";

export type InteractionToolName = "computer" | "browser";

/** An empty agent override keeps the chat model instead of inheriting a specialist. */
export function resolveInteractionModel(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  toolName: InteractionToolName,
): string | undefined {
  if (!config) {
    return undefined;
  }
  const field = toolName === "computer" ? "computerModel" : "browserModel";
  const entry = agentId ? resolveAgentEntry(config, agentId) : undefined;
  return (entry?.[field] ?? config.agents?.defaults?.[field])?.trim() || undefined;
}
