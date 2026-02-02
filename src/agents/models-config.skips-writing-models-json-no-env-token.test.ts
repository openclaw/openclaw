import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-models-" });
}

const MODELS_CONFIG: OpenClawConfig = {
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

const MODEL_AUTH_ENV_PATTERNS = [/_API_KEY$/, /_OAUTH_TOKEN$/, /_TOKEN$/];
const MODEL_AUTH_ENV_EXACT = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GCLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
]);

function stubModelAuthEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      MODEL_AUTH_ENV_EXACT.has(key) ||
      MODEL_AUTH_ENV_PATTERNS.some((pattern) => pattern.test(key))
    ) {
      vi.stubEnv(key, undefined);
    }
  }
}

describe("models-config", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("skips writing models.json when no env token or profile exists", async () => {
    await withTempHome(async (home) => {
      try {
        stubModelAuthEnv();
        vi.resetModules();
        const { ensureOpenClawModelsJson } = await import("./models-config.js");

        const agentDir = path.join(home, "agent-empty");
        const result = await ensureOpenClawModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        await expect(fs.stat(path.join(agentDir, "models.json"))).rejects.toThrow();
        expect(result.wrote).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      await ensureOpenClawModelsJson(MODELS_CONFIG);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { baseUrl?: string }>;
      };

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });
  it("adds minimax provider when MINIMAX_API_KEY is set", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        const { ensureOpenClawModelsJson } = await import("./models-config.js");
        const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

        await ensureOpenClawModelsJson({});

        const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            {
              baseUrl?: string;
              apiKey?: string;
              models?: Array<{ id: string }>;
            }
          >;
        };
        expect(parsed.providers.minimax?.baseUrl).toBe("https://api.minimax.chat/v1");
        expect(parsed.providers.minimax?.apiKey).toBe("MINIMAX_API_KEY");
        const ids = parsed.providers.minimax?.models?.map((model) => model.id);
        expect(ids).toContain("MiniMax-M2.1");
        expect(ids).toContain("MiniMax-VL-01");
      } finally {
        if (prevKey === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = prevKey;
        }
      }
    });
  });
  it("adds synthetic provider when SYNTHETIC_API_KEY is set", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.SYNTHETIC_API_KEY;
      process.env.SYNTHETIC_API_KEY = "sk-synthetic-test";
      try {
        const { ensureOpenClawModelsJson } = await import("./models-config.js");
        const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

        await ensureOpenClawModelsJson({});

        const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            {
              baseUrl?: string;
              apiKey?: string;
              models?: Array<{ id: string }>;
            }
          >;
        };
        expect(parsed.providers.synthetic?.baseUrl).toBe("https://api.synthetic.new/anthropic");
        expect(parsed.providers.synthetic?.apiKey).toBe("SYNTHETIC_API_KEY");
        const ids = parsed.providers.synthetic?.models?.map((model) => model.id);
        expect(ids).toContain("hf:MiniMaxAI/MiniMax-M2.1");
      } finally {
        if (prevKey === undefined) {
          delete process.env.SYNTHETIC_API_KEY;
        } else {
          process.env.SYNTHETIC_API_KEY = prevKey;
        }
      }
    });
  });
});
