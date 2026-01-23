import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_GITHUB_COPILOT_BASE_URL } from "../providers/github-copilot-utils.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "clawdbot-models-" });
}

const _MODELS_CONFIG: ClawdbotConfig = {
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

  it("auto-injects github-copilot provider when token is present", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "gh-token";

      try {
        vi.resetModules();

        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        const agentDir = path.join(home, "agent-default-base-url");
        await ensureClawdbotModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string; models?: unknown[] }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(DEFAULT_GITHUB_COPILOT_BASE_URL);
        expect(parsed.providers["github-copilot"]?.models?.length ?? 0).toBe(0);
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
      }
    });
  });
  it("uses enterprise URL from auth profiles to derive base URL", async () => {
    await withTempHome(async () => {
      try {
        vi.resetModules();

        const agentDir = path.join(process.env.HOME ?? home, "agent-enterprise");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          JSON.stringify(
            {
              version: 1,
              profiles: {
                "github-copilot:github": {
                  type: "oauth",
                  provider: "github-copilot",
                  refresh: "gh-token",
                  access: "gh-token",
                  expires: 0,
                  enterpriseUrl: "company.ghe.com",
                },
              },
            },
            null,
            2,
          ),
        );

        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        await ensureClawdbotModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(
          "https://copilot-api.company.ghe.com",
        );
      } finally {
        // no-op
      }
    });
  });
});
