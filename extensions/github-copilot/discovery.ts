import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const COPILOT_IDE_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface CopilotApiModel {
  id: string;
  name?: string;
  version?: string;
  object?: string;
  model_picker_enabled?: boolean;
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    object?: string;
    supports?: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      dimensions?: boolean;
      vision?: boolean;
      reasoning?: boolean;
    };
    tokenizer?: string;
  };
  policy?: {
    state?: string; // "enabled" | "disabled"
  };
  preview_state?: string;
}

interface CopilotModelsResponse {
  data: CopilotApiModel[];
}

function inferApiType(model: CopilotApiModel): ModelDefinitionConfig["api"] {
  const id = model.id.toLowerCase();
  if (id.startsWith("claude")) {
    return "anthropic-messages";
  }
  // Default to openai-responses which is what the copilot extension normally uses
  return "openai-responses";
}

function buildModelDefinition(model: CopilotApiModel): ModelDefinitionConfig {
  const caps = model.capabilities;
  const limits = caps?.limits;
  const supports = caps?.supports;

  return {
    id: model.id,
    name: model.name ?? model.id,
    api: inferApiType(model),
    reasoning: supports?.reasoning ?? false,
    input: supports?.vision ? (["text", "image"] as const) : (["text"] as const),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits?.max_prompt_tokens ?? 128_000,
    maxTokens: limits?.max_output_tokens ?? 8192,
  };
}

export async function discoverCopilotModels(params: {
  baseUrl: string;
  copilotToken: string;
  knownModelIds?: Set<string>;
}): Promise<ModelDefinitionConfig[]> {
  const { baseUrl, copilotToken, knownModelIds } = params;

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${copilotToken}`,
      ...COPILOT_IDE_HEADERS,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return [];
  }

  const body = (await res.json()) as CopilotModelsResponse;
  if (!Array.isArray(body.data)) {
    return [];
  }

  return body.data
    .filter((m) => {
      // Only enabled models
      if (m.policy?.state && m.policy.state !== "enabled") return false;
      // Only chat-capable models (skip embeddings, etc.)
      if (m.capabilities?.type && m.capabilities.type !== "chat") return false;
      // Skip models already in the built-in list
      if (knownModelIds?.has(m.id)) return false;
      return true;
    })
    .map(buildModelDefinition);
}
