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

async function writeAuthProfiles(
  agentDir: string,
  profiles: Record<string, unknown>,
  order?: Record<string, string[]>,
) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({ version: 1, ...(order ? { order } : {}), profiles }, null, 2),
  );
}

function expectBearerAuthHeader(fetchMock: { mock: { calls: unknown[][] } }, token: string) {
  const [, opts] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
  expect(opts?.headers?.Authorization).toBe(`Bearer ${token}`);
}

describe("models-config", () => {
  it("uses auth.order for github-copilot profile selection when env tokens are missing", async () => {
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

        await ensureOpenClawModelsJson(
          {
            auth: {
              order: {
                "github-copilot": ["github-copilot:beta", "github-copilot:alpha"],
              },
            },
            models: { providers: {} },
          },
          agentDir,
        );
        expectBearerAuthHeader(fetchMock, "beta-token");
      });
    });
  });

  it("falls back to the first github-copilot profile when auth.order is missing", async () => {
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

  it("falls back past ordered github-copilot profiles that are unresolved at runtime", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        const fetchMock = mockCopilotTokenExchangeSuccess();
        const agentDir = path.join(home, "agent-profiles");
        try {
          delete process.env.MISSING_COPILOT_REF_TOKEN;
          await writeAuthProfiles(agentDir, {
            "github-copilot:preferred": {
              type: "token",
              provider: "github-copilot",
              tokenRef: { source: "env", provider: "default", id: "MISSING_COPILOT_REF_TOKEN" },
            },
            "github-copilot:backup": {
              type: "token",
              provider: "github-copilot",
              token: "backup-token",
            },
          });

          await ensureOpenClawModelsJson(
            {
              auth: {
                order: {
                  "github-copilot": ["github-copilot:preferred", "github-copilot:backup"],
                },
              },
              models: { providers: {} },
            },
            agentDir,
          );
          expectBearerAuthHeader(fetchMock, "backup-token");
        } finally {
          delete process.env.MISSING_COPILOT_REF_TOKEN;
        }
      });
    });
  });

  it("falls back to stored github-copilot profiles when ordered tokenRefs stay unresolved", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        const fetchMock = mockCopilotTokenExchangeSuccess();
        const agentDir = path.join(home, "agent-profiles");
        try {
          delete process.env.MISSING_ORDERED_COPILOT_TOKEN;
          await writeAuthProfiles(agentDir, {
            "github-copilot:preferred": {
              type: "token",
              provider: "github-copilot",
              tokenRef: {
                source: "env",
                provider: "default",
                id: "MISSING_ORDERED_COPILOT_TOKEN",
              },
            },
            "github-copilot:backup": {
              type: "token",
              provider: "github-copilot",
              token: "backup-token",
            },
          });

          await ensureOpenClawModelsJson(
            {
              auth: {
                order: {
                  "github-copilot": ["github-copilot:preferred"],
                },
              },
              models: { providers: {} },
            },
            agentDir,
          );
          expectBearerAuthHeader(fetchMock, "backup-token");
        } finally {
          delete process.env.MISSING_ORDERED_COPILOT_TOKEN;
        }
      });
    });
  });

  it("falls back to config auth.order when stored github-copilot order is stale", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        const fetchMock = mockCopilotTokenExchangeSuccess();
        const agentDir = path.join(home, "agent-profiles");
        await writeAuthProfiles(
          agentDir,
          {
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
          {
            "github-copilot": ["github-copilot:missing"],
          },
        );

        await ensureOpenClawModelsJson(
          {
            auth: {
              order: {
                "github-copilot": ["github-copilot:beta"],
              },
            },
            models: { providers: {} },
          },
          agentDir,
        );
        expectBearerAuthHeader(fetchMock, "beta-token");
      });
    });
  });

  it("falls back to stored github-copilot profiles when config-ordered tokenRefs stay unresolved", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        const fetchMock = mockCopilotTokenExchangeSuccess();
        const agentDir = path.join(home, "agent-profiles");
        try {
          delete process.env.MISSING_PREFERRED_COPILOT_TOKEN;
          await writeAuthProfiles(
            agentDir,
            {
              "github-copilot:preferred": {
                type: "token",
                provider: "github-copilot",
                tokenRef: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_PREFERRED_COPILOT_TOKEN",
                },
              },
              "github-copilot:backup": {
                type: "token",
                provider: "github-copilot",
                token: "backup-token",
              },
            },
            {
              "github-copilot": ["github-copilot:missing"],
            },
          );

          await ensureOpenClawModelsJson(
            {
              auth: {
                order: {
                  "github-copilot": ["github-copilot:preferred"],
                },
              },
              models: { providers: {} },
            },
            agentDir,
          );
          expectBearerAuthHeader(fetchMock, "backup-token");
        } finally {
          delete process.env.MISSING_PREFERRED_COPILOT_TOKEN;
        }
      });
    });
  });
});
