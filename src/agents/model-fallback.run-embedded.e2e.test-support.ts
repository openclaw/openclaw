// Mock-free store/config/workspace helpers and provider-failure fixtures for the embedded-runner
// model-fallback e2e suite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileFailureReason } from "./auth-profiles.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

export function makeModelFallbackConfig(primaryProvider = "openai"): OpenClawConfig {
  const apiKeyField = ["api", "Key"].join("");
  return {
    agents: {
      defaults: {
        model: {
          primary: `${primaryProvider}/mock-1`,
          fallbacks: ["groq/mock-2"],
        },
      },
      list: [{ id: "test" }],
    },
    models: {
      providers: {
        [primaryProvider]: {
          api: "openai-responses",
          [apiKeyField]: `${primaryProvider}-test-key`, // pragma: allowlist secret
          baseUrl: `https://example.com/${primaryProvider}`,
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
        groq: {
          api: "openai-responses",
          [apiKeyField]: "groq-test-key", // pragma: allowlist secret
          baseUrl: "https://example.com/groq",
          models: [
            {
              id: "mock-2",
              name: "Mock 2",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
}

export async function withModelFallbackWorkspace<T>(
  fn: (ctx: { agentDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  // Each e2e case gets isolated agent/workspace dirs because usage stats and
  // transcripts are part of the fallback behavior under test.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-fallback-"));
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    return await fn({ agentDir, workspaceDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function writeFallbackAuthStore(
  agentDir: string,
  usageStats?: Record<
    string,
    {
      lastUsed?: number;
      cooldownUntil?: number;
      disabledUntil?: number;
      disabledReason?: AuthProfileFailureReason;
      failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
    }
  >,
  options?: { primaryProvider?: string },
) {
  const primaryProvider = options?.primaryProvider ?? "openai";
  const primaryProfileId = `${primaryProvider}:p1`;
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [primaryProfileId]: {
          type: "api_key",
          provider: primaryProvider,
          key: "sk-primary",
        },
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
      usageStats:
        usageStats ??
        ({
          [primaryProfileId]: { lastUsed: 1 },
          "groq:p1": { lastUsed: 2 },
        } as const),
    },
    agentDir,
  );
}

export async function readFallbackUsageStats(agentDir: string) {
  return ensureAuthProfileStore(agentDir, { syncExternalCli: false }).usageStats ?? {};
}

export async function writeFallbackMultiProfileAuthStore(
  agentDir: string,
  options?: { openAiProfileCount?: 2 | 3 },
) {
  const includeThirdOpenAiProfile = options?.openAiProfileCount !== 2;
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-openai-1" },
        "openai:p2": { type: "api_key", provider: "openai", key: "sk-openai-2" },
        ...(includeThirdOpenAiProfile
          ? { "openai:p3": { type: "api_key" as const, provider: "openai", key: "placeholder" } }
          : {}),
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
        ...(includeThirdOpenAiProfile ? { "openai:p3": { lastUsed: 3 } } : {}),
        "groq:p1": { lastUsed: 4 },
      },
    },
    agentDir,
  );
}

export const OVERLOADED_ERROR_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
export const CLOUDFLARE_502_ERROR_PAYLOAD =
  "502 <!doctype html><html><head><title>502 Bad Gateway</title></head>" +
  "<body><h1>502 Bad Gateway</h1><p>cloudflare-nginx</p></body></html>";
export const RATE_LIMIT_ERROR_MESSAGE = "rate limit exceeded";
export const LONG_RATE_LIMIT_ERROR_MESSAGE =
  "429 Too Many Requests: subscription usage limit reached";
export const NO_ENDPOINTS_FOUND_ERROR_MESSAGE =
  "404 No endpoints found for deepseek/deepseek-r1:free.";
// Captured verbatim from a real local HTTP 429 round-tripped through the real
// OpenRouter transport (streamOpenAICompletions) carrying the exact body reported
// in #147546 — not hand-typed. See test/plugins/openrouter-per-day-rate-limit.integration.test.ts
// and src/agents/embedded-agent-runner/run/attempt-recovery.test.ts, which independently
// verify a real HTTP round-trip produces this exact string.
export const REAL_TRANSPORT_PER_DAY_CAP_ERROR_MESSAGE =
  "429 Rate limit exceeded: free-models-per-day-high-balance.";
export const NO_ERROR_DETAILS_MESSAGE = "Unknown error (no error details in response)";

export type EmbeddedAttemptParams = {
  provider: string;
  modelId?: string;
  authProfileId?: string;
};

export function makeFallbackSuccessAttempt(): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: ["fallback ok"],
    lastAssistant: buildEmbeddedRunnerAssistant({
      provider: "groq",
      model: "mock-2",
      stopReason: "stop",
      content: [{ type: "text", text: "fallback ok" }],
    }),
  });
}
