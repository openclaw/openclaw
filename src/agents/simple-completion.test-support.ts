import { createServer, type RequestListener } from "node:http";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Context, Model } from "../llm/types.js";

function modelDefaults() {
  return {
    reasoning: false,
    input: ["text"] satisfies Model["input"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

export function completionModelDefinition(
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  const id = overrides.id ?? "fixture-model";
  return { ...modelDefaults(), id, name: id, ...overrides };
}

export function completionModel(overrides: Partial<Model> = {}): Model {
  const id = overrides.id ?? "fixture-model";
  return {
    ...modelDefaults(),
    id,
    name: id,
    provider: "ollama",
    api: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    ...overrides,
  };
}

export function completionContext(content = "Complete", timestamp = 1) {
  return { messages: [{ role: "user", content, timestamp }] } satisfies Context;
}
export function completionConfig(
  provider: string,
  modelProvider: ModelProviderConfig,
  options: Omit<OpenClawConfig, "models"> = {},
): OpenClawConfig {
  return { ...options, models: { providers: { [provider]: modelProvider } } };
}

export function assertPrepared<T extends object>(
  result: T,
): asserts result is Exclude<T, { error: string }> {
  if ("error" in result) {
    throw new Error(String(result.error));
  }
}

export function completionChunk(text: string, model = "selected-model") {
  return `data: ${JSON.stringify({
    id: "completion-response",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
}

export async function startCompletionServer(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing completion fixture port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
