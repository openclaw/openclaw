/**
 * Fetch the model list from the Copilot API.
 * Returns raw API model objects with capabilities/limits.
 *
 * API docs: https://docs.github.com/en/copilot/using-github-copilot/using-the-github-copilot-api
 */

export interface CopilotApiVisionLimits {
  max_prompt_image_size?: number;
  max_prompt_images?: number;
  supported_media_types?: string[];
}

export interface CopilotApiModelLimits {
  max_context_window_tokens?: number;
  max_output_tokens?: number;
  max_non_streaming_output_tokens?: number;
  max_prompt_tokens?: number;
  vision?: CopilotApiVisionLimits;
}

export interface CopilotApiModelSupports {
  vision?: boolean;
  tool_calls?: boolean;
  streaming?: boolean;
  parallel_tool_calls?: boolean;
  structured_outputs?: boolean;
  adaptive_thinking?: boolean;
  max_thinking_budget?: number;
  min_thinking_budget?: number;
  reasoning_effort?: string[];
}

export interface CopilotApiModel {
  id: string;
  name: string;
  version: string;
  vendor: string;
  family?: string;
  type?: string;
  supported_endpoints?: string[];
  capabilities?: {
    limits?: CopilotApiModelLimits;
    supports?: CopilotApiModelSupports;
    family?: string;
    type?: string;
  };
}

interface CopilotModelsResponse {
  data: CopilotApiModel[];
}

// IDE headers required by the Copilot API to accept /models requests.
const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";

export async function fetchCopilotModels(
  baseUrl: string,
  apiToken: string,
): Promise<CopilotApiModel[]> {
  const url = `${baseUrl}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "Editor-Version": COPILOT_EDITOR_VERSION,
      "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
      "User-Agent": COPILOT_USER_AGENT,
      "Copilot-Integration-Id": "vscode-chat",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Copilot /models API returned ${response.status}`);
  }
  const body = (await response.json()) as CopilotModelsResponse;
  return body.data ?? [];
}
