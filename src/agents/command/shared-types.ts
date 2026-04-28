import { sanitizeForPromptLiteral } from "../sanitize-for-prompt.js";
import { normalizeToolName } from "../tool-policy-shared.js";

export type AgentStreamParams = {
  /** Provider stream params override (best-effort). */
  temperature?: number;
  maxTokens?: number;
  /** Provider fast-mode override (best-effort). */
  fastMode?: boolean;
};

// Simplified tool definition for client-provided tools (OpenResponses hosted tools)
export type ClientToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** Strict argument enforcement (Responses API). Propagated from the request. */
    strict?: boolean;
  };
};

export function normalizeClientToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed !== name) {
    throw new Error("client tool name must not include leading or trailing whitespace");
  }
  if (sanitizeForPromptLiteral(name) !== name) {
    throw new Error("client tool name contains unsupported control or format characters");
  }
  return name;
}

export function normalizeClientToolDefinitions(
  tools?: ClientToolDefinition[],
): ClientToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  const seenNormalizedNames = new Set<string>();
  const normalized = tools.map((tool) => {
    const name = normalizeClientToolName(tool.function?.name ?? "");
    if (!name) {
      throw new Error("client tool name is required");
    }
    const normalizedName = normalizeToolName(name);
    if (seenNormalizedNames.has(normalizedName)) {
      throw new Error(`duplicate client tool name: ${name}`);
    }
    seenNormalizedNames.add(normalizedName);
    return {
      ...tool,
      function: {
        ...tool.function,
        name,
      },
    };
  });
  return normalized;
}
