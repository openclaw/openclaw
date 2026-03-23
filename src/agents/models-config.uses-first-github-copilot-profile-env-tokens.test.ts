import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  mockCopilotTokenExchangeSuccess,
  withCopilotGithubToken,
  withUnsetCopilotTokenEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

async function writeAuthProfiles(agentDir: string, profiles: Record<string, unknown>) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({ version: 1, profiles }, null, 2),
  );
}

function expectBearerAuthHeader(fetchMock: { mock: { calls: unknown[][] } }, token: string) {
  const [, opts] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
  expect(opts?.headers?.Authorization).toBe(`Bearer ${token}`);
}

describe("models-config", () => {
  it("uses the first github-copilot profile when env tokens are missing", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        const fetchMock = mockCopilotTokenExchangeSuccess();
        const agentDir = path.join(home, "agent-profiles");
        await writeAuthProfiles(agentDir, {
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
        });

        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);
        expectBearerAuthHeader(fetchMock, "alpha-token");
      });
    });
  });

  it("does not override explicit github-copilot provider config", async () => {
    await withTempHome(async () => {
      await withCopilotGithubToken("gh-token", async () => {
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
      });
    });
  });

  it("uses tokenRef env var when github-copilot profile omits plaintext token", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        const fetchMock = mockCopilotTokenExchangeSuccess();
        const agentDir = path.join(home, "agent-profiles");
        process.env.COPILOT_REF_TOKEN = "token-from-ref-env";
        try {
          await writeAuthProfiles(agentDir, {
            "github-copilot:default": {
              type: "token",
              provider: "github-copilot",
              tokenRef: { source: "env", provider: "default", id: "COPILOT_REF_TOKEN" },
            },
          });

          await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);
          expectBearerAuthHeader(fetchMock, "token-from-ref-env");
        } finally {
          delete process.env.COPILOT_REF_TOKEN;
        }
      });
    });
  });
});
