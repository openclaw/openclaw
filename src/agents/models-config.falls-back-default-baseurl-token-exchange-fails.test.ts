import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { DEFAULT_COPILOT_API_BASE_URL } from "./github-copilot-token.js";
import {
  installModelsConfigTestHooks,
  mockCopilotTokenExchangeSuccess,
  withUnsetCopilotTokenEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";

vi.unmock("./models-config.js");
vi.unmock("./agent-paths.js");
vi.unmock("../plugins/manifest-registry.js");
vi.unmock("../plugins/provider-runtime.js");
vi.unmock("../plugins/provider-runtime.runtime.js");
vi.unmock("../secrets/provider-env-vars.js");

installModelsConfigTestHooks({ restoreFetch: true });

let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;

async function loadModelsConfigForTest(): Promise<void> {
  vi.resetModules();
  vi.doUnmock("./models-config.js");
  vi.doUnmock("./agent-paths.js");
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  ({ ensureOpenClawModelsJson } = await import("./models-config.js"));
}

beforeEach(loadModelsConfigForTest);

async function readCopilotBaseUrl(agentDir: string) {
  const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    providers: Record<string, { baseUrl?: string }>;
  };
  return parsed.providers["github-copilot"]?.baseUrl;
}

describe("models-config", () => {
  it("falls back to default baseUrl when token exchange fails", async () => {
    await withTempHome(async () => {
      await withEnvAsync(
        {
          COPILOT_GITHUB_TOKEN: "gh-token",
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS: "github-copilot",
        },
        async () => {
          const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ message: "boom" }),
          });
          globalThis.fetch = fetchMock as unknown as typeof fetch;

          const { agentDir } = await ensureOpenClawModelsJson({ models: { providers: {} } });
          expect(await readCopilotBaseUrl(agentDir)).toBe(DEFAULT_COPILOT_API_BASE_URL);
        },
      );
    });
  });

  it("uses agentDir override auth profiles for copilot injection", async () => {
    await withTempHome(async (home) => {
      await withUnsetCopilotTokenEnv(async () => {
        mockCopilotTokenExchangeSuccess();
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

        expect(await readCopilotBaseUrl(agentDir)).toBe("https://api.copilot.example");
      });
    });
  });
});
