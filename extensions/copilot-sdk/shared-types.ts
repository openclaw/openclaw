/**
 * Narrow subset of the OpenClaw model definition shape we emit. Keeping this
 * local and structural avoids dragging the full config type graph into the
 * plugin package at build time; OpenClaw's runtime accepts any object that
 * matches `ModelDefinitionConfig` structurally.
 */
export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api: "openai-completions";
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsTools?: boolean };
};

/**
 * Subset of an OpenAI chat-completions request that the shim understands.
 * Fields we don't use are intentionally optional `unknown` so new client
 * options don't break parsing.
 */
export type OpenAiChatMessage = {
  role: string;
  content?: string | OpenAiContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
};

export type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: string; [k: string]: unknown };

export type OpenAiChatRequest = {
  model: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  [k: string]: unknown;
};
