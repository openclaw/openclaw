import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

describe("models-config", () => {
  it("uses the first github-copilot profile when env tokens are missing", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;

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
        const agentDir = path.join(home, "agent-profiles");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          JSON.stringify(
            {
              version: 1,
              profiles: {
                "github-copilot:alpha": {
                  type: "token",
                  provider: "github-copilot",
                  token: "alpha-token",
                },
                "github-copilot:beta": {
                  type: "token",
                  provider: "github-copilot",
                  token: "beta-token",
                },
              },
            },
            null,
            2,
          ),
        );

        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const [, opts] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
        expect(opts?.headers?.Authorization).toBe("Bearer alpha-token");
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
      }
    });
  });

  it("does not override explicit github-copilot provider config", async () => {
    await withTempHome(async () => {
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
        await ensureOpenClawModelsJson({
          models: {
            providers: {
              "github-copilot": {
                baseUrl: "https://copilot.local",
                api: "openai-responses",
                models: [],
              },
            },
          },
        });

        const agentDir = resolveOpenClawAgentDir();
        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe("https://copilot.local");
      } finally {
        if (previous === undefined) {
          delete process.env.COPILOT_GITHUB_TOKEN;
        } else {
          process.env.COPILOT_GITHUB_TOKEN = previous;
        }
      }
    });
  });
});
