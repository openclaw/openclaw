import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_LOCAL_PROVIDER_BASE_URLS, type ResolvedBookWriterConfig } from "./config.js";
import { DEFAULT_MODEL_CATALOG } from "./model-governor.js";
import { countWords } from "./text.js";
import type { ModelBenchRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export type ProcessMemorySample = {
  pid: number;
  rssKb: number;
  command: string;
};

export type LiveModelBenchOptions = {
  config: ResolvedBookWriterConfig;
  model: string;
  provider?: string;
  baseUrl?: string;
  prompt?: string;
  maxTokens?: number;
  stableContextTokens?: number;
  qualityScore?: number;
  fetchImpl?: typeof fetch;
  processSampler?: (provider: string) => Promise<ProcessMemorySample[]>;
};

const DEFAULT_BENCH_PROMPT =
  "Write a vivid, original 180-word scene about a warehouse auditor finding a harmless but important clue. Return only prose.";

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

function providerPatterns(provider: string): RegExp[] {
  if (provider === "ollama") {
    return [/ollama/i];
  }
  if (provider === "lmstudio") {
    return [/lm\s*studio/i, /lmstudio/i, /llama-server/i, /llama\.cpp/i];
  }
  return [new RegExp(provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")];
}

export function parsePsMemorySamples(output: string, provider: string): ProcessMemorySample[] {
  const patterns = providerPatterns(provider);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) {
        return [];
      }
      const command = match[3];
      if (!patterns.some((pattern) => pattern.test(command))) {
        return [];
      }
      return [
        {
          pid: Number(match[1]),
          rssKb: Number(match[2]),
          command,
        },
      ];
    });
}

export async function sampleProviderProcessMemory(
  provider: string,
): Promise<ProcessMemorySample[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,rss=,command="], {
    maxBuffer: 2 * 1024 * 1024,
  });
  return parsePsMemorySamples(stdout, provider);
}

function peakMemoryGb(sampleSets: ProcessMemorySample[][]): number | undefined {
  if (sampleSets.every((samples) => samples.length === 0)) {
    return undefined;
  }
  const peakKb = Math.max(
    ...sampleSets.map((samples) => samples.reduce((sum, sample) => sum + sample.rssKb, 0)),
  );
  return Number((peakKb / 1024 / 1024).toFixed(2));
}

function completionTokensFromChatCompletionsResponse(json: {
  usage?: { completion_tokens?: unknown; output_tokens?: unknown };
  choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
}): { text: string; tokens: number } {
  const text =
    typeof json.choices?.[0]?.message?.content === "string"
      ? json.choices[0].message.content
      : typeof json.choices?.[0]?.text === "string"
        ? json.choices[0].text
        : "";
  const usageTokens =
    typeof json.usage?.completion_tokens === "number"
      ? json.usage.completion_tokens
      : typeof json.usage?.output_tokens === "number"
        ? json.usage.output_tokens
        : undefined;
  return {
    text,
    tokens: usageTokens ?? Math.max(1, Math.ceil(countWords(text) * 1.35)),
  };
}

function completionTokensFromOllamaResponse(json: {
  message?: { content?: unknown };
  eval_count?: unknown;
}): { text: string; tokens: number } {
  const text = typeof json.message?.content === "string" ? json.message.content : "";
  const usageTokens = typeof json.eval_count === "number" ? json.eval_count : undefined;
  return {
    text,
    tokens: usageTokens ?? Math.max(1, Math.ceil(countWords(text) * 1.35)),
  };
}

function catalogRecord(model: string): ModelBenchRecord | undefined {
  return DEFAULT_MODEL_CATALOG.find((record) => record.model === model);
}

export async function runLiveModelBench(options: LiveModelBenchOptions): Promise<ModelBenchRecord> {
  const provider = options.provider ?? options.config.localProvider;
  const baseUrl = (options.baseUrl ?? resolveProviderBaseUrl(options.config, provider)).replace(
    /\/$/,
    "",
  );
  const fetcher = options.fetchImpl ?? fetch;
  const sampler = options.processSampler ?? sampleProviderProcessMemory;
  const catalog = catalogRecord(options.model);
  const before = await sampler(provider).catch(() => []);
  const started = performance.now();

  try {
    const response =
      provider === "ollama"
        ? await fetcher(`${normalizeOllamaBaseUrl(baseUrl)}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: options.model,
              messages: [
                {
                  role: "system",
                  content: "Return only final prose. Do not add headings, analysis, or markdown.",
                },
                { role: "user", content: options.prompt ?? DEFAULT_BENCH_PROMPT },
              ],
              stream: false,
              think: false,
              keep_alive: "30m",
              options: {
                temperature: 0.2,
                num_predict: options.maxTokens ?? 256,
              },
            }),
          })
        : await fetcher(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(provider === "lmstudio" ? { authorization: "Bearer lmstudio" } : {}),
            },
            body: JSON.stringify({
              model: options.model,
              messages: [
                {
                  role: "system",
                  content: "Return only final prose. Do not add headings, analysis, or markdown.",
                },
                { role: "user", content: options.prompt ?? DEFAULT_BENCH_PROMPT },
              ],
              temperature: 0.2,
              max_tokens: options.maxTokens ?? 256,
            }),
          });
    const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
    const after = await sampler(provider).catch(() => []);
    if (!response.ok) {
      throw new Error(`${provider} returned HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      usage?: { completion_tokens?: unknown; output_tokens?: unknown };
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
      message?: { content?: unknown };
      eval_count?: unknown;
    };
    const completion =
      provider === "ollama"
        ? completionTokensFromOllamaResponse(json)
        : completionTokensFromChatCompletionsResponse(json);
    if (!completion.text.trim()) {
      throw new Error(`${provider} response did not contain benchmark text`);
    }
    const measuredPeak = peakMemoryGb([before, after]);
    const tokensPerSecond = Number((completion.tokens / elapsedSeconds).toFixed(2));
    return {
      provider,
      model: options.model,
      source: "measured",
      peakMemoryGb: measuredPeak ?? catalog?.peakMemoryGb ?? 0,
      tokensPerSecond,
      stableContextTokens: options.stableContextTokens ?? catalog?.stableContextTokens ?? 32768,
      crashRate: 0,
      qualityScore: options.qualityScore ?? catalog?.qualityScore ?? 0.75,
      measuredAt: new Date().toISOString(),
      notes: [
        `Live benchmark completed against ${baseUrl}.`,
        `Generated ${completion.tokens} completion token(s) in ${elapsedSeconds.toFixed(2)}s.`,
        measuredPeak === undefined
          ? "Provider process memory was not visible; retained catalog memory budget."
          : `Provider process RSS sample peak was ${measuredPeak} GB.`,
      ],
    };
  } catch (error) {
    const after = await sampler(provider).catch(() => []);
    const measuredPeak = peakMemoryGb([before, after]);
    return {
      provider,
      model: options.model,
      source: "unavailable",
      peakMemoryGb: measuredPeak ?? catalog?.peakMemoryGb ?? 0,
      tokensPerSecond: 0,
      stableContextTokens: options.stableContextTokens ?? catalog?.stableContextTokens ?? 32768,
      crashRate: 1,
      qualityScore: 0,
      measuredAt: new Date().toISOString(),
      notes: [
        `Live benchmark failed against ${baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}
