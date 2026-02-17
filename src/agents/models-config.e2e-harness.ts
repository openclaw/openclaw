import { afterEach, beforeEach, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export async function withModelsTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-models-" });
}

export function installModelsConfigTestHooks(opts?: { restoreFetch?: boolean }) {
  let previousHome: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    if (opts?.restoreFetch && originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });
}

export async function withTempEnv<T>(vars: string[], fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const envVar of vars) {
    previous[envVar] = process.env[envVar];
  }

  try {
    return await fn();
  } finally {
    for (const envVar of vars) {
      const value = previous[envVar];
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
  }
}

export function unsetEnv(vars: string[]) {
  for (const envVar of vars) {
    delete process.env[envVar];
  }
}

export const COPILOT_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

export async function withUnsetCopilotTokenEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withTempEnv(COPILOT_TOKEN_ENV_VARS, async () => {
    unsetEnv(COPILOT_TOKEN_ENV_VARS);
    return fn();
  });
}

export function mockCopilotTokenExchangeSuccess(): MockFn {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      token: "copilot-token;proxy-ep=proxy.copilot.example",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

export const MODELS_CONFIG_IMPLICIT_ENV_VARS = [
  "CLOUDFLARE_AI_GATEWAY_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_HUB_TOKEN",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OLLAMA_API_KEY",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "QIANFAN_API_KEY",
  "SYNTHETIC_API_KEY",
  "TOGETHER_API_KEY",
  "VENICE_API_KEY",
  "VLLM_API_KEY",
  "XIAOMI_API_KEY",
  // Avoid ambient AWS creds unintentionally enabling Bedrock discovery.
  "AWS_ACCESS_KEY_ID",
  "AWS_CONFIG_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SESSION_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SHARED_CREDENTIALS_FILE",
];

export const CUSTOM_PROXY_MODELS_CONFIG: OpenClawConfig = {
  models: {
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "TEST_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B (Proxy)",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
};
