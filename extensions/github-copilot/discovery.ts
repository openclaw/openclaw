import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveCopilotTransportApi } from "./models.js";

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
  // Route Claude models through the Anthropic transport so they get
  // Copilot-specific stream shaping (header patching, cache markers,
  // thinking-block replay policy). Must stay in sync with
  // resolveCopilotTransportApi in models.ts.
  return resolveCopilotTransportApi(model.id);
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
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits?.max_prompt_tokens ?? 128_000,
    maxTokens: limits?.max_output_tokens ?? 8192,
  };
}

export async function discoverCopilotModels(params: {
  baseUrl: string;
  copilotToken: string;
  knownModelIds?: Set<string>;
  extraHeaders?: Record<string, string>;
}): Promise<ModelDefinitionConfig[]> {
  const { baseUrl, copilotToken, knownModelIds, extraHeaders } = params;

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_IDE_HEADERS,
        ...extraHeaders,
      },
    },
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    timeoutMs: 10_000,
    auditContext: "github-copilot-model-discovery",
  });

  try {
    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as CopilotModelsResponse;
    if (!Array.isArray(body.data)) {
      return [];
    }

    return body.data
      .filter((m) => {
        // Must have an id
        if (!m.id) {
          return false;
        }
        // Only enabled models
        if (m.policy?.state && m.policy.state !== "enabled") {
          return false;
        }
        // Only chat-capable models (skip embeddings, etc.)
        if (m.capabilities?.type && m.capabilities.type !== "chat") {
          return false;
        }
        // Skip models already in the built-in list
        if (knownModelIds?.has(m.id)) {
          return false;
        }
        return true;
      })
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(buildModelDefinition);
  } finally {
    await release();
  }
}
