import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-models-" });
}

const _MODELS_CONFIG: OpenClawConfig = {
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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-injects github-copilot provider when token is present", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "gh-token";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          token: "copilot-token;proxy-ep=proxy.copilot.example",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const agentDir = path.join(home, "agent-default-base-url");
        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string; models?: unknown[] }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe("https://api.copilot.example");
        expect(parsed.providers["github-copilot"]?.models?.length ?? 0).toBe(0);
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
      }
    });
  });

  it("prefers COPILOT_GITHUB_TOKEN over GH_TOKEN and GITHUB_TOKEN", async () => {
    await withTempHome(async () => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
      process.env.GH_TOKEN = "gh-token";
      process.env.GITHUB_TOKEN = "github-token";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          token: "copilot-token;proxy-ep=proxy.copilot.example",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        await ensureOpenClawModelsJson({ models: { providers: {} } });

        const [, opts] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
        expect(opts?.headers?.Authorization).toBe("Bearer copilot-token");
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
        process.env.GH_TOKEN = previousGh;
        process.env.GITHUB_TOKEN = previousGithub;
      }
    });
  });
});
