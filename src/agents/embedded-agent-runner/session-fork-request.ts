import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Model } from "../../llm/types.js";
import { gateAgentToolExecution } from "../agent-tool-availability.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../tools/common.js";
import { isCurrentEmbeddedRunAttachment } from "./run-state.js";
import { resolveActiveEmbeddedRunBySessionFile } from "./runs.js";
import { sameToolParameters } from "./session-tool-definition.js";

// A tool-free fork sets tool_choice none, which also stops provider-hosted tools (for example
// web search) that run before any client-side gate sees them.
const TOOL_CHOICE_NONE = new Map<Model["api"], "object" | "string">([
  ["anthropic-messages", "object"],
  ["openai-responses", "string"],
  ["openai-chatgpt-responses", "string"],
  ["openai-completions", "string"],
]);

/** Function declarations the run can gate; anything else may run at the provider. */
function isClientTool(tool: unknown): boolean {
  if (!isRecord(tool)) {
    return false;
  }
  if (tool.type === undefined) {
    // Anthropic client tools, or a Gemini functionDeclarations group.
    return (
      "input_schema" in tool || Object.keys(tool).every((key) => key === "functionDeclarations")
    );
  }
  return tool.type === "function" || tool.type === "custom";
}

// Gemini SDK requests carry tools in config.
const requestTools = (payload: Record<string, unknown>) =>
  [payload.tools, isRecord(payload.config) && payload.config.tools].flatMap((list) =>
    Array.isArray(list) ? list : [],
  );

/** The source session's last checkpointed system prompt and tool definitions. */
export type SessionForkPin = {
  prefix: string;
  tools: Array<Pick<AnyAgentTool, "name" | "description" | "parameters">>;
};

export type SessionForkRequest = {
  /** The source's pin: the fork's own requests send this prompt and tool list unchanged. */
  pin?: SessionForkPin;
};

/**
 * The source's pinned tool definitions in their sent order, then any tool only the fork
 * built (a plugin's granted tool). A pinned tool the fork did not build refuses its calls.
 */
export function listSessionForkTools(pin: SessionForkPin, tools: AnyAgentTool[]): AnyAgentTool[] {
  const built = new Map(tools.map((tool) => [tool.name, tool]));
  return [
    ...pin.tools.map((definition) => {
      const tool = built.get(definition.name);
      if (!tool) {
        return gateAgentToolExecution(
          {
            ...definition,
            label: definition.name,
            execute: async () => ({ content: [], details: {} }),
          },
          `${definition.name} is not available in this background run. Do not retry ${definition.name}.`,
        );
      }
      return sameToolParameters(definition.parameters, tool.parameters)
        ? copyAgentToolMetadata(tool, { ...tool, description: definition.description })
        : tool;
    }),
    ...tools.filter((tool) => !pin.tools.some((definition) => definition.name === tool.name)),
  ];
}

/** Keep the parent's listed tools, but stop provider-hosted tools in a tool-free fork. */
export function applySessionForkRequest(
  payload: Record<string, unknown>,
  run: { api: Model["api"]; allowedTools: readonly string[] },
): void {
  const { api, allowedTools } = run;
  if (allowedTools.length > 0) {
    return;
  }
  const shape = TOOL_CHOICE_NONE.get(api);
  if (!shape) {
    if (!requestTools(payload).every(isClientTool)) {
      throw new Error(
        `Session forks cannot disable provider-hosted tools on provider API ${api}. Remove hosted tools from this model's requests to fork it.`,
      );
    }
  } else if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    payload.tool_choice = shape === "object" ? { type: "none" } : "none";
  } else {
    delete payload.tool_choice;
  }
}

/** The current same-route parent run's prompt-cache key; request bytes come from history. */
export function readLiveSessionForkRequest(params: {
  sessionKey: string;
  model: { provider: string; model: string };
}): { promptCacheKey?: string } | undefined {
  // SQLite-backed runs register under the canonical key, not the legacy transcript path.
  const attachment = resolveActiveEmbeddedRunBySessionFile(params.sessionKey);
  const live =
    attachment && isCurrentEmbeddedRunAttachment(attachment)
      ? attachment.handle.readSessionForkContext?.()
      : undefined;
  const sameRoute = (model: Model | undefined) =>
    model?.provider === params.model.provider && model.id === params.model.model;
  if (!live || !sameRoute(live.model)) {
    return undefined;
  }
  return live.promptCacheKey ? { promptCacheKey: live.promptCacheKey } : {};
}
