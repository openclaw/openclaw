import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  installModelsConfigTestHooks,
  mockCopilotTokenExchangeSuccess,
  withCopilotGithubToken,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

describe("models-config", () => {
  it("auto-injects github-copilot provider when token is present", async () => {
    await withTempHome(async (home) => {
      await withCopilotGithubToken("gh-token", async () => {
        const agentDir = path.join(home, "agent-default-base-url");
        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string; models?: unknown[] }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe("https://api.copilot.example");
        expect(parsed.providers["github-copilot"]?.models?.length ?? 0).toBe(0);
      });
    });
  });

  it("prefers COPILOT_GITHUB_TOKEN over GH_TOKEN and GITHUB_TOKEN", async () => {
    await withTempHome(async () => {
      await withEnvAsync(
        {
          COPILOT_GITHUB_TOKEN: "copilot-token",
          GH_TOKEN: "gh-token",
          GITHUB_TOKEN: "github-token",
        },
        async () => {
          const fetchMock = mockCopilotTokenExchangeSuccess();

          await ensureOpenClawModelsJson({ models: { providers: {} } });

          const [, opts] = fetchMock.mock.calls[0] as [
            string,
            { headers?: Record<string, string> },
          ];
          expect(opts?.headers?.Authorization).toBe("Bearer copilot-token");
        },
      );
    });
  });
});
