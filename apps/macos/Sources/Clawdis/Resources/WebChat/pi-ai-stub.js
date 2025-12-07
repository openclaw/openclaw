// Minimal browser-friendly stub for @mariozechner/pi-ai
const DEFAULT_MODEL = {
  provider: "anthropic",
  id: "claude-opus-4-5",
  name: "Claude 3.5 Sonnet",
  api: "anthropic-messages",
  input: ["text"],
  output: ["text"],
  maxTokens: 200000,
  reasoning: true,
  headers: undefined,
  baseUrl: undefined,
};

export function getModel(provider, id) {
  return { ...DEFAULT_MODEL, provider, id, name: id };
}

export function getModels() {
  return [DEFAULT_MODEL];
}

export function getProviders() {
  return [
    {
      id: DEFAULT_MODEL.provider,
      name: "Anthropic",
      models: getModels(),
    },
  ];
}

export async function complete() {
  return { text: "" };
}

export function agentLoop() {
  throw new Error("agentLoop is not available in embedded web chat");
}

export class AssistantMessageEventStream {
  push() {}
  end() {}
}

export const StringEnum = (values, options = {}) => ({
  enum: [...values],
  description: options.description,
});

export function parseStreamingJson() {
  return null;
}
