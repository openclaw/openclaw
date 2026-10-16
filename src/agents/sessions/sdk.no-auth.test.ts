import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import OpenAI from "openai";
import { expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

it.each(["none", undefined] as const)(
  "honors provider auth %s after the session merges caller headers",
  async (auth) => {
    const model = {
      provider: "custom",
      id: "model",
      name: "Synthetic model",
      api: "openai-completions",
      baseUrl: "https://inference.example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model;
    const registry = ModelRegistry.inMemory(
      AuthStorage.inMemory({ custom: { type: "api_key", key: "synthetic-stored-key" } }),
    );
    let sentHeaders: Headers | undefined;
    let request: Promise<unknown> | undefined;
    registry.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      auth,
      models: [model],
      headers: { "X-Provider": "visible-provider-header" },
      streamSimple: (selectedModel, _context, options) => {
        const client = new OpenAI({
          apiKey: options?.apiKey,
          baseURL: selectedModel.baseUrl,
          defaultHeaders: { ...selectedModel.headers, ...options?.headers },
          maxRetries: 0,
          fetch: async (_url, init) => {
            sentHeaders = new Headers(init?.headers);
            return Response.json({ id: "synthetic-completion", choices: [] });
          },
        });
        request = client.chat.completions.create({ model: selectedModel.id, messages: [] });
        const stream = createAssistantMessageEventStream();
        stream.end();
        return stream;
      },
    });
    const { session } = await createAgentSession({
      modelRegistry: registry,
      model,
      systemPrompt: "Synthetic no-auth session",
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    });
    try {
      const stream = session.agent.streamFn;
      if (!stream) {
        throw new Error("Expected the session's provider stream");
      }
      await stream(
        model,
        { systemPrompt: "", messages: [] },
        {
          headers: {
            Authorization: "Bearer synthetic-caller-key",
            "X-Caller": "visible-caller-header",
          },
        },
      );
      await request;
      expect(sentHeaders?.get("authorization")).toBe(
        auth === "none" ? null : "Bearer synthetic-caller-key",
      );
      expect(sentHeaders?.get("x-provider")).toBe("visible-provider-header");
      expect(sentHeaders?.get("x-caller")).toBe("visible-caller-header");
    } finally {
      session.dispose();
    }
  },
);
