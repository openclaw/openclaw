import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";
import {
  assertQaLiveCodexAuthAvailable,
  stageQaLiveAnthropicSetupToken,
  stageQaLiveApiKeyProfiles,
} from "./providers/live-frontier/auth.js";
import { readQaAuthProfiles } from "./providers/shared/auth-store.js";
import { stageQaMockAuthProfiles } from "./providers/shared/mock-auth.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
const setup = createQaGatewaySetupHarness();
let stateDir: string;

beforeEach(async () => {
  stateDir = await tempDirs.makeTempDir("qa-auth-");
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE", undefined);
});

afterEach(async () => {
  await setup.cleanup();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await tempDirs.cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function readProfiles(root: string, agentId: string) {
  return (await readQaAuthProfiles(path.join(root, "agents", agentId, "agent"))).profiles;
}

async function expectStaged(
  cfg: OpenClawConfig,
  root: string,
  id: string,
  credential: { provider: string; type: string; [key: string]: unknown },
  agents = ["main", "qa"],
  displayName?: string,
) {
  expect(cfg.auth?.profiles).toEqual({
    [id]: expect.objectContaining({
      provider: credential.provider,
      mode: credential.type,
      ...(displayName ? { displayName } : {}),
    }),
  });
  for (const agent of agents) {
    expect(await readProfiles(root, agent)).toEqual({ [id]: expect.objectContaining(credential) });
  }
}

function assertCodexAuth(cfg: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return assertQaLiveCodexAuthAvailable({
    cfg,
    env,
    providerIds: ["openai"],
    readCodexCredentials: () => null,
  });
}

function stageLive(env: NodeJS.ProcessEnv, cfg: OpenClawConfig = {}) {
  return stageQaLiveApiKeyProfiles({ cfg, stateDir, providerIds: ["openai"], env });
}

describe("QA Gateway auth profile staging", () => {
  it.each(["explicit", "default"])(
    "prepares selected providers and auth from the %s JSON5 config",
    async (source) => {
      const home = await tempDirs.makeTempDir("qa-json5-home-");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await mkdir(path.dirname(configPath));
      await writeFile(
        configPath,
        // Comments, single quotes, unquoted keys and a trailing comma exercise JSON5.
        "// JSON5 provider config\n{models:{providers:{'custom-openai':{baseUrl:'https://proxy.example.test/v1'," +
          "api:'openai-responses',apiKey:'qa-json5-key',models:[]}," +
          "ignored:{baseUrl:'https://ignored.example.test',models:[]},}}}",
      );
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const {
        cfg,
        stateDir: customStateDir,
        configPath: childConfigPath,
      } = await setup.prepare(
        {
          providerMode: "live-frontier",
          primaryModel: "custom-openai/fixture",
          alternateModel: "custom-openai/fixture",
        },
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: source === "explicit" ? configPath : undefined,
        },
      );
      expect(JSON.parse(await readFile(childConfigPath, "utf8")).models.providers).toEqual({
        "custom-openai": {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          apiKey: "qa-json5-key",
          models: [],
        },
      });
      expect(cfg.plugins?.allow).toContain("openai");
      await expectStaged(cfg, customStateDir, "qa-live-custom-openai-env", {
        type: "api_key",
        provider: "custom-openai",
        key: "qa-json5-key",
      });
    },
  );

  it("stages a live Anthropic setup-token profile for isolated QA workers", async () => {
    const token = `sk-ant-oat01-${"c".repeat(80)}`;
    vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", token);

    const cfg = await stageQaLiveAnthropicSetupToken({ cfg: {}, stateDir });

    await expectStaged(
      cfg,
      stateDir,
      "anthropic:qa-setup-token",
      { type: "token", provider: "anthropic", token },
      ["main"],
    );
  });

  it.each([
    { source: "provider env", apiKey: undefined, env: { OPENAI_API_KEY: "qa-live-key" } },
    { source: "config literal", apiKey: "qa-live-key", env: {} },
  ])("stages $source API-key auth for isolated live QA workers", async ({ apiKey, env }) => {
    const cfg = await stageLive(
      env,
      apiKey === undefined
        ? {}
        : { models: { providers: { openai: { baseUrl: "", models: [], apiKey } } } },
    );
    await expectStaged(
      cfg,
      stateDir,
      "qa-live-openai-env",
      { type: "api_key", provider: "openai", key: "qa-live-key" },
      undefined,
      "QA live openai env credential",
    );
    expect(() => assertCodexAuth(cfg)).not.toThrow();
  });

  it("keeps the Codex API-key handoff out of profiles and maps it only into the gateway env", async () => {
    const baseEnv = { OPENCLAW_QA_CODEX_API_KEY_HANDOFF: "  synthetic-qa-api-key  " };
    const cfg = await stageLive(baseEnv);

    expect(cfg.auth?.profiles).toBeUndefined();
    for (const agent of ["main", "qa"]) {
      expect(await readProfiles(stateDir, agent)).toEqual({});
    }
    const { env } = await setup.prepare({ providerMode: "live-frontier" }, baseEnv);
    expect(env.CODEX_API_KEY).toBe("synthetic-qa-api-key");
    expect("OPENCLAW_QA_CODEX_API_KEY_HANDOFF" in env).toBe(false);
  });

  it.each([
    {
      name: "custom OpenAI-compatible provider",
      cfg: {
        models: { providers: { openai: { baseUrl: "https://proxy.example.test/v1", models: [] } } },
      },
      env: { CODEX_HOME: path.join(os.tmpdir(), "missing-openclaw-codex-home") },
    },
    {
      name: "forced Codex API-key fallback",
      cfg: {},
      env: {
        OPENCLAW_LIVE_OPENAI_KEY: "qa-live-codex-fallback-key",
        OPENCLAW_QA_FORCE_RUNTIME: "codex",
      },
    },
  ])("accepts $name without Codex credentials", ({ cfg, env }) => {
    expect(() => assertCodexAuth(cfg, env)).not.toThrow();
  });

  it("stages mock profiles only for the requested agents and providers when callers override the defaults", async () => {
    const cfg = await stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
      agentIds: ["qa"],
      providers: ["openai"],
    });

    await expectStaged(cfg, stateDir, "qa-mock-openai", { provider: "openai", type: "api_key" }, [
      "qa",
    ]);

    await expect(
      lstat(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
    ).rejects.toThrow(/ENOENT/);
  });
});
