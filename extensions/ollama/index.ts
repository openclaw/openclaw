import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const PROVIDER_ID = "ollama";
const PROVIDER_LABEL = "Ollama (Local)";
const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4096;

// Well-known Ollama models with their context windows
const KNOWN_MODELS: Record<string, { context: number; reasoning?: boolean }> = {
  "mistral:latest": { context: 32_768 },
  "llama3.2:latest": { context: 128_000 },
  "llama3.2:3b": { context: 128_000 },
  "llama3.2:1b": { context: 128_000 },
  "phi4-mini:latest": { context: 16_384 },
  "phi4:latest": { context: 16_384 },
  "deepseek-r1:7b": { context: 32_768, reasoning: true },
  "deepseek-r1:14b": { context: 32_768, reasoning: true },
  "qwen2.5-coder:latest": { context: 32_768 },
  "qwen2.5-coder:7b": { context: 32_768 },
  "codellama:latest": { context: 16_384 },
  "gemma2:latest": { context: 8_192 },
};

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

/**
 * Probe Ollama server for available models
 */
export async function probeOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Check if Ollama server is running
 */
export async function isOllamaRunning(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function normalizeBaseUrl(value: string): string {
  let normalized = value.trim();
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || DEFAULT_BASE_URL;
}

export function validateBaseUrl(value: string): string | undefined {
  const normalized = normalizeBaseUrl(value);
  try {
    new URL(normalized);
  } catch {
    return "Enter a valid URL (e.g., http://localhost:11434)";
  }
  return undefined;
}

export function parseModelIds(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
}

export function buildModelDefinition(modelId: string) {
  const known = KNOWN_MODELS[modelId];
  return {
    id: modelId,
    name: modelId.replace(":latest", "").replace(":", " "),
    api: "openai-completions",
    reasoning: known?.reasoning ?? false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: known?.context ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

const ollamaPlugin = {
  id: "ollama",
  name: "Ollama",
  description: "Ollama local LLM provider plugin",
  configSchema: emptyPluginConfigSchema(),

  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/ollama",
      aliases: ["local", "offline"],
      auth: [
        {
          id: "local",
          label: "Local Ollama server",
          hint: "Connect to Ollama running on localhost (no API key required)",
          kind: "custom",
          run: async (ctx) => {
            // Step 1: Get base URL
            const baseUrlInput = await ctx.prompter.text({
              message: "Ollama server URL",
              initialValue: DEFAULT_BASE_URL,
              validate: validateBaseUrl,
            });

            const baseUrl = normalizeBaseUrl(baseUrlInput);

            // Step 2: Check if Ollama is running
            const spin = ctx.prompter.progress("Checking Ollama server…");
            const isRunning = await isOllamaRunning(baseUrl);

            if (!isRunning) {
              spin.stop("Ollama not reachable");
              await ctx.prompter.note(
                `Could not connect to Ollama at ${baseUrl}.\n\nMake sure Ollama is running:\n  ollama serve`,
                "Connection failed",
              );
              throw new Error(`Ollama server not reachable at ${baseUrl}`);
            }

            // Step 3: Detect available models
            spin.message("Detecting models…");
            const detectedModels = await probeOllamaModels(baseUrl);

            if (detectedModels.length === 0) {
              spin.stop("No models found");
              await ctx.prompter.note(
                `No models found. Pull a model first:\n  ollama pull mistral`,
                "No models",
              );
              throw new Error("No Ollama models available");
            }

            spin.stop(`Found ${detectedModels.length} model(s)`);

            // Step 4: Let user select models
            const modelInput = await ctx.prompter.text({
              message: `Models to enable (${detectedModels.length} available)`,
              initialValue: detectedModels.slice(0, 5).join(", "),
              validate: (value) =>
                parseModelIds(value).length > 0 ? undefined : "Select at least one model",
            });

            const modelIds = parseModelIds(modelInput);
            const defaultModelId = modelIds[0] ?? "mistral:latest";
            const defaultModelRef = `ollama/${defaultModelId}`;

            // Step 5: Return configuration
            return {
              profiles: [
                {
                  profileId: "ollama:local",
                  credential: {
                    type: "token",
                    provider: PROVIDER_ID,
                    token: "local", // Ollama doesn't need auth, but OpenClaw needs a credential
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: `${baseUrl}/v1`,
                      api: "openai-completions",
                      authHeader: false,
                      models: modelIds.map(buildModelDefinition),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      modelIds.map((modelId) => [`ollama/${modelId}`, {}]),
                    ),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: [
                `Connected to Ollama at ${baseUrl}`,
                `Enabled models: ${modelIds.join(", ")}`,
                "Zero cost - runs entirely locally",
                "Run `ollama pull <model>` to add more models",
              ],
            };
          },
        },
      ],
    });
  },
};

export default ollamaPlugin;
