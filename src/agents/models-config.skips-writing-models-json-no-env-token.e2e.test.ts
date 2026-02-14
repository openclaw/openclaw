import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

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
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      const previousKimiCode = process.env.KIMI_API_KEY;
      const previousMinimax = process.env.MINIMAX_API_KEY;
      const previousMoonshot = process.env.MOONSHOT_API_KEY;
      const previousSynthetic = process.env.SYNTHETIC_API_KEY;
      const previousVenice = process.env.VENICE_API_KEY;
      const previousXiaomi = process.env.XIAOMI_API_KEY;
      const previousOllama = process.env.OLLAMA_API_KEY;
      const previousVllm = process.env.VLLM_API_KEY;
      const previousTogether = process.env.TOGETHER_API_KEY;
      const previousHuggingfaceHub = process.env.HUGGINGFACE_HUB_TOKEN;
      const previousHuggingfaceHf = process.env.HF_TOKEN;
      const previousQianfan = process.env.QIANFAN_API_KEY;
      const previousNvidia = process.env.NVIDIA_API_KEY;
      const previousAwsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const previousAwsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const previousAwsSessionToken = process.env.AWS_SESSION_TOKEN;
      const previousAwsProfile = process.env.AWS_PROFILE;
      const previousAwsRegion = process.env.AWS_REGION;
      const previousAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
      const previousAwsSharedCredentials = process.env.AWS_SHARED_CREDENTIALS_FILE;
      const previousAwsConfigFile = process.env.AWS_CONFIG_FILE;
      const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
      const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.KIMI_API_KEY;
      delete process.env.MINIMAX_API_KEY;
      delete process.env.MOONSHOT_API_KEY;
      delete process.env.SYNTHETIC_API_KEY;
      delete process.env.VENICE_API_KEY;
      delete process.env.XIAOMI_API_KEY;
      delete process.env.OLLAMA_API_KEY;
      delete process.env.VLLM_API_KEY;
      delete process.env.TOGETHER_API_KEY;
      delete process.env.HUGGINGFACE_HUB_TOKEN;
      delete process.env.HF_TOKEN;
      delete process.env.QIANFAN_API_KEY;
      delete process.env.NVIDIA_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;
      delete process.env.AWS_PROFILE;
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      delete process.env.AWS_CONFIG_FILE;
      delete process.env.OPENCLAW_AGENT_DIR;
      delete process.env.PI_CODING_AGENT_DIR;

      try {
        const agentDir = path.join(home, "agent-empty");
        // Avoid merging in the user's real main auth store via OPENCLAW_AGENT_DIR.
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const result = await ensureOpenClawModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        await expect(fs.stat(path.join(agentDir, "models.json"))).rejects.toThrow();
        expect(result.wrote).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.COPILOT_GITHUB_TOKEN;
        } else {
          process.env.COPILOT_GITHUB_TOKEN = previous;
        }
        if (previousGh === undefined) {
          delete process.env.GH_TOKEN;
        } else {
          process.env.GH_TOKEN = previousGh;
        }
        if (previousGithub === undefined) {
          delete process.env.GITHUB_TOKEN;
        } else {
          process.env.GITHUB_TOKEN = previousGithub;
        }
        if (previousKimiCode === undefined) {
          delete process.env.KIMI_API_KEY;
        } else {
          process.env.KIMI_API_KEY = previousKimiCode;
        }
        if (previousMinimax === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = previousMinimax;
        }
        if (previousMoonshot === undefined) {
          delete process.env.MOONSHOT_API_KEY;
        } else {
          process.env.MOONSHOT_API_KEY = previousMoonshot;
        }
        if (previousSynthetic === undefined) {
          delete process.env.SYNTHETIC_API_KEY;
        } else {
          process.env.SYNTHETIC_API_KEY = previousSynthetic;
        }
        if (previousVenice === undefined) {
          delete process.env.VENICE_API_KEY;
        } else {
          process.env.VENICE_API_KEY = previousVenice;
        }
        if (previousXiaomi === undefined) {
          delete process.env.XIAOMI_API_KEY;
        } else {
          process.env.XIAOMI_API_KEY = previousXiaomi;
        }
        if (previousOllama === undefined) {
          delete process.env.OLLAMA_API_KEY;
        } else {
          process.env.OLLAMA_API_KEY = previousOllama;
        }
        if (previousVllm === undefined) {
          delete process.env.VLLM_API_KEY;
        } else {
          process.env.VLLM_API_KEY = previousVllm;
        }
        if (previousTogether === undefined) {
          delete process.env.TOGETHER_API_KEY;
        } else {
          process.env.TOGETHER_API_KEY = previousTogether;
        }
        if (previousHuggingfaceHub === undefined) {
          delete process.env.HUGGINGFACE_HUB_TOKEN;
        } else {
          process.env.HUGGINGFACE_HUB_TOKEN = previousHuggingfaceHub;
        }
        if (previousHuggingfaceHf === undefined) {
          delete process.env.HF_TOKEN;
        } else {
          process.env.HF_TOKEN = previousHuggingfaceHf;
        }
        if (previousQianfan === undefined) {
          delete process.env.QIANFAN_API_KEY;
        } else {
          process.env.QIANFAN_API_KEY = previousQianfan;
        }
        if (previousNvidia === undefined) {
          delete process.env.NVIDIA_API_KEY;
        } else {
          process.env.NVIDIA_API_KEY = previousNvidia;
        }
        if (previousAwsAccessKeyId === undefined) {
          delete process.env.AWS_ACCESS_KEY_ID;
        } else {
          process.env.AWS_ACCESS_KEY_ID = previousAwsAccessKeyId;
        }
        if (previousAwsSecretAccessKey === undefined) {
          delete process.env.AWS_SECRET_ACCESS_KEY;
        } else {
          process.env.AWS_SECRET_ACCESS_KEY = previousAwsSecretAccessKey;
        }
        if (previousAwsSessionToken === undefined) {
          delete process.env.AWS_SESSION_TOKEN;
        } else {
          process.env.AWS_SESSION_TOKEN = previousAwsSessionToken;
        }
        if (previousAwsProfile === undefined) {
          delete process.env.AWS_PROFILE;
        } else {
          process.env.AWS_PROFILE = previousAwsProfile;
        }
        if (previousAwsRegion === undefined) {
          delete process.env.AWS_REGION;
        } else {
          process.env.AWS_REGION = previousAwsRegion;
        }
        if (previousAwsDefaultRegion === undefined) {
          delete process.env.AWS_DEFAULT_REGION;
        } else {
          process.env.AWS_DEFAULT_REGION = previousAwsDefaultRegion;
        }
        if (previousAwsSharedCredentials === undefined) {
          delete process.env.AWS_SHARED_CREDENTIALS_FILE;
        } else {
          process.env.AWS_SHARED_CREDENTIALS_FILE = previousAwsSharedCredentials;
        }
        if (previousAwsConfigFile === undefined) {
          delete process.env.AWS_CONFIG_FILE;
        } else {
          process.env.AWS_CONFIG_FILE = previousAwsConfigFile;
        }
        if (previousAgentDir === undefined) {
          delete process.env.OPENCLAW_AGENT_DIR;
        } else {
          process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
        }
        if (previousPiAgentDir === undefined) {
          delete process.env.PI_CODING_AGENT_DIR;
        } else {
          process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
        }
      }
    });
  });
  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
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
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
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
        expect(parsed.providers.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
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
      const prevKey = process.env.SYNTHETIC_API_KEY;
      process.env.SYNTHETIC_API_KEY = "sk-synthetic-test";
      try {
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
