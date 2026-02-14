import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COPILOT_API_BASE_URL } from "../providers/github-copilot-token.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

describe("models-config", () => {
  it("falls back to default baseUrl when token exchange fails", async () => {
    await withTempHome(async () => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "gh-token";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "boom" }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        await ensureOpenClawModelsJson({ models: { providers: {} } });

        const agentDir = path.join(process.env.HOME ?? "", ".openclaw", "agents", "main", "agent");
        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(DEFAULT_COPILOT_API_BASE_URL);
      } finally {
        if (previous === undefined) {
          delete process.env.COPILOT_GITHUB_TOKEN;
        } else {
          process.env.COPILOT_GITHUB_TOKEN = previous;
        }
      }
    });
  });

  it("uses agentDir override auth profiles for copilot injection", async () => {
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
        const agentDir = path.join(home, "agent-override");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          JSON.stringify(
            {
              version: 1,
              profiles: {
                "github-copilot:github": {
                  type: "token",
                  provider: "github-copilot",
                  token: "gh-profile-token",
                },
              },
            },
            null,
            2,
          ),
        );

        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe("https://api.copilot.example");
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
});
