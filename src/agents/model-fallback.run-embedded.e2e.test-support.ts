import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { ProfileUsageStats } from "./auth-profiles/types.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

export function makeModelFallbackConfig(primaryProvider = "openai"): OpenClawConfig {
  const apiKeyField = ["api", "Key"].join("");
  const provider = (id: string, modelNumber: number) => ({
    api: "openai-responses" as const,
    [apiKeyField]: `${id}-test-key`, // pragma: allowlist secret
    baseUrl: `https://example.com/${id}`,
    models: [
      {
        id: `mock-${modelNumber}`,
        name: `Mock ${modelNumber}`,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 2048,
      },
    ],
  });
  return {
    agents: {
      defaults: {
        model: {
          primary: `${primaryProvider}/mock-1`,
          fallbacks: ["groq/mock-2"],
        },
      },
      entries: { test: {} },
    },
    models: {
      providers: {
        [primaryProvider]: provider(primaryProvider, 1),
        groq: provider("groq", 2),
      },
    },
  } satisfies OpenClawConfig;
}

type UsageStats = Record<
  string,
  Pick<
    ProfileUsageStats,
    "lastUsed" | "cooldownUntil" | "disabledUntil" | "disabledReason" | "failureCounts"
  >
>;
type ProfileRow = [id: string, provider: string, key: string, lastUsed: number];

function saveProfiles(agentDir: string, rows: ProfileRow[], usageStats?: UsageStats) {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: Object.fromEntries(
        rows.map(([id, provider, key]) => [id, { type: "api_key" as const, provider, key }]),
      ),
      usageStats:
        usageStats ?? Object.fromEntries(rows.map((row) => [row[0], { lastUsed: row[3] }])),
    },
    agentDir,
  );
}

export async function withModelFallbackWorkspace<T>(
  fn: (ctx: { agentDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  // Each e2e case gets isolated agent/workspace dirs because usage stats and
  // transcripts are part of the fallback behavior under test.
  const root = await fs.realpath(
    // openclaw-temp-dir: allow callback-owned roots must match canonical agent database paths
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-fallback-")),
  );
  const agentDir = path.join(root, "agents", "test", "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    return await fn({ agentDir, workspaceDir });
  } finally {
    clearRuntimeConfigSnapshot();
    await closeOpenClawAgentDatabasesAsync(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function writeFallbackAuthStore(
  agentDir: string,
  usageStats?: UsageStats,
  options?: { primaryProvider?: string },
) {
  const primaryProvider = options?.primaryProvider ?? "openai";
  saveProfiles(
    agentDir,
    [
      [`${primaryProvider}:p1`, primaryProvider, "sk-primary", 1],
      ["groq:p1", "groq", "sk-groq", 2],
    ],
    usageStats,
  );
}

export async function readFallbackUsageStats(agentDir: string) {
  return ensureAuthProfileStore(agentDir, { syncExternalCli: false }).usageStats ?? {};
}

export async function writeFallbackMultiProfileAuthStore(
  agentDir: string,
  options?: { openAiProfileCount?: 2 | 3 },
) {
  const rows: ProfileRow[] = [
    ["openai:p1", "openai", "sk-openai-1", 1],
    ["openai:p2", "openai", "sk-openai-2", 2],
  ];
  if (options?.openAiProfileCount !== 2) {
    rows.push(["openai:p3", "openai", "placeholder", 3]);
  }
  saveProfiles(agentDir, [...rows, ["groq:p1", "groq", "sk-groq", 4]]);
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
// Real OpenRouter HTTP 429 from #147546; transport proof lives in
// test/plugins/openrouter-per-day-rate-limit.integration.test.ts.
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
