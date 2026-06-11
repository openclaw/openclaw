import { DEFAULT_LOCAL_PROVIDER_BASE_URLS, type ResolvedBookWriterConfig } from "./config.js";
import type { ModelBenchRecord } from "./types.js";

export type GenerateTextResult = {
  text: string;
  provider: string;
  model: string;
  live: boolean;
  gaps: string[];
};

export type GenerateTextOptions = {
  config: ResolvedBookWriterConfig;
  model?: ModelBenchRecord;
  prompt: string;
  liveModel?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_BOOK_WRITER_GENERATION_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507";

function providerLabel(provider: string): string {
  if (provider === "ollama") {
    return "Ollama";
  }
  if (provider === "lmstudio") {
    return "LM Studio";
  }
  return provider;
}

function resolveProviderBaseUrl(config: ResolvedBookWriterConfig, provider: string): string {
  const configured = config.localBaseUrl.replace(/\/$/, "");
  const configuredProviderDefault = DEFAULT_LOCAL_PROVIDER_BASE_URLS[config.localProvider].replace(
    /\/$/,
    "",
  );
  if (provider !== config.localProvider && configured === configuredProviderDefault) {
    const providerDefault =
      DEFAULT_LOCAL_PROVIDER_BASE_URLS[provider as keyof typeof DEFAULT_LOCAL_PROVIDER_BASE_URLS];
    return (providerDefault ?? config.localBaseUrl).replace(/\/$/, "");
  }
  return configured;
}

function normalizeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "").replace(/\/v1$/i, "");
}

function promptForProvider(provider: string, model: string, prompt: string): string {
  if (provider === "ollama" && /^qwen3/i.test(model)) {
    return `/no_think\n${prompt}`;
  }
  return prompt;
}

export async function generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
  const provider = options.model?.provider ?? options.config.localProvider;
  const model = options.model?.model ?? options.config.localModel;
  const liveRequested = options.liveModel ?? true;
  const label = providerLabel(provider);
  if (!liveRequested) {
    return {
      text: "",
      provider,
      model,
      live: false,
      gaps: [`Live ${label} generation disabled; deterministic offline drafting was used.`],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
  );
  try {
    const fetcher = options.fetchImpl ?? fetch;
    if (provider === "ollama") {
      const response = await fetcher(
        `${normalizeOllamaBaseUrl(resolveProviderBaseUrl(options.config, provider))}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content:
                  "You write original, publication-ready book material. Return only the requested manuscript text in the message content.",
              },
              { role: "user", content: promptForProvider(provider, model, options.prompt) },
            ],
            stream: false,
            think: false,
            keep_alive: "30m",
            options: {
              temperature: 0.55,
              num_predict: options.maxTokens ?? DEFAULT_MAX_TOKENS,
            },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`${label} returned HTTP ${response.status}`);
      }
      const json = (await response.json()) as { message?: { content?: unknown } };
      const text = typeof json.message?.content === "string" ? json.message.content : "";
      if (!text.trim()) {
        throw new Error(`${label} response did not contain text`);
      }
      return { text, provider, model, live: true, gaps: [] };
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider === "lmstudio") {
      headers.authorization = "Bearer lmstudio";
    }
    const response = await fetcher(
      `${resolveProviderBaseUrl(options.config, provider)}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You write original, publication-ready book material. Return only the requested manuscript text in the message content.",
            },
            { role: "user", content: promptForProvider(provider, model, options.prompt) },
          ],
          temperature: 0.55,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    };
    const text =
      typeof json.choices?.[0]?.message?.content === "string"
        ? json.choices[0].message.content
        : typeof json.choices?.[0]?.text === "string"
          ? json.choices[0].text
          : "";
    if (!text.trim()) {
      throw new Error(`${label} response did not contain text`);
    }
    return { text, provider, model, live: true, gaps: [] };
  } catch (error) {
    return {
      text: "",
      provider,
      model,
      live: false,
      gaps: [
        `${label} generation unavailable (${error instanceof Error ? error.message : String(error)}); deterministic offline drafting was used and approval is blocked until live generation is verified.`,
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}
