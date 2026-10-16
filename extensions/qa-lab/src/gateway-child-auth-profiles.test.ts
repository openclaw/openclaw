import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQaRuntimeEnvParams } from "./gateway-child-command.test-support.js";
import { buildQaRuntimeEnv } from "./gateway-child-env.js";
import {
  assertQaLiveCodexAuthAvailable,
  stageQaLiveAnthropicSetupToken,
  stageQaLiveApiKeyProfiles,
} from "./providers/live-frontier/auth.js";
import { readQaAuthProfiles } from "./providers/shared/auth-store.js";
import { stageQaMockAuthProfiles } from "./providers/shared/mock-auth.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

beforeEach(() => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await tempDirs.cleanup();
  vi.unstubAllEnvs();
});

function readAuthProfileStore(stateDir: string, agentId: string) {
  return readQaAuthProfiles(path.join(stateDir, "agents", agentId, "agent"));
}

function assertCodexAuth(cfg: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return assertQaLiveCodexAuthAvailable({
    cfg,
    env,
    providerIds: ["openai"],
    readCodexCredentials: () => null,
  });
}

async function stageLive(env: NodeJS.ProcessEnv, cfg: OpenClawConfig = {}) {
  const stateDir = await tempDirs.makeTempDir("qa-live-auth-");
  return {
    stateDir,
    cfg: await stageQaLiveApiKeyProfiles({ cfg, stateDir, providerIds: ["openai"], env }),
  };
}

describe("QA Gateway auth profile staging", () => {
  it("stages a live Anthropic setup-token profile for isolated QA workers", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-setup-token-state-");
    const token = `sk-ant-oat01-${"c".repeat(80)}`;

    const cfg = await stageQaLiveAnthropicSetupToken({
      cfg: {},
      stateDir,
      env: { OPENCLAW_LIVE_SETUP_TOKEN_VALUE: token },
    });

    expect(cfg.auth?.profiles?.["anthropic:qa-setup-token"]).toMatchObject({
      provider: "anthropic",
      mode: "token",
    });
    expect(
      (await readAuthProfileStore(stateDir, "main")).profiles["anthropic:qa-setup-token"],
    ).toMatchObject({ type: "token", provider: "anthropic", token });
  });

  it.each([
    { source: "provider env", apiKey: undefined, env: { OPENAI_API_KEY: "qa-live-key" } },
    { source: "config literal", apiKey: "qa-live-key", env: {} },
  ])("stages $source API-key auth for isolated live QA workers", async ({ apiKey, env }) => {
    const { stateDir, cfg } = await stageLive(
      env,
      apiKey === undefined
        ? {}
        : {
            models: { providers: { openai: { baseUrl: "", models: [], apiKey } } },
          },
    );
    expect(cfg.auth?.profiles?.["qa-live-openai-env"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
      displayName: "QA live openai env credential",
    });
    expect(Object.values(cfg.auth?.profiles ?? {})).not.toContainEqual(
      expect.objectContaining({ provider: "anthropic" }),
    );
    for (const agentId of ["main", "qa"]) {
      const profiles = (await readAuthProfileStore(stateDir, agentId)).profiles;
      expect(profiles["qa-live-openai-env"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "qa-live-key",
      });
      expect(Object.values(profiles)).not.toContainEqual(
        expect.objectContaining({ provider: "anthropic" }),
      );
    }
    expect(() => assertCodexAuth(cfg)).not.toThrow();
  });

  it("keeps the Codex API-key handoff out of profiles and maps it only into the gateway env", async () => {
    const baseEnv = { OPENCLAW_QA_CODEX_API_KEY_HANDOFF: "  synthetic-qa-api-key  " };
    const { stateDir, cfg } = await stageLive(baseEnv);

    expect(cfg.auth?.profiles).toBeUndefined();
    for (const agentId of ["main", "qa"]) {
      expect((await readAuthProfileStore(stateDir, agentId)).profiles).toEqual({});
    }
    const env = buildQaRuntimeEnv({
      ...makeQaRuntimeEnvParams(baseEnv),
      stateDir,
      providerMode: "live-frontier",
    });
    expect(env.CODEX_API_KEY).toBe("synthetic-qa-api-key");
    expect(env).not.toHaveProperty("OPENCLAW_QA_CODEX_API_KEY_HANDOFF");
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
    const stateDir = await tempDirs.makeTempDir("qa-mock-auth-override-");

    const cfg = await stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
      agentIds: ["qa"],
      providers: ["openai"],
    });

    expect(cfg.auth?.profiles?.["qa-mock-openai"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
    });
    expect(cfg.auth?.profiles?.["qa-mock-anthropic"]).toBeUndefined();

    const qaStore = await readAuthProfileStore(stateDir, "qa");
    expect(qaStore.profiles["qa-mock-openai"]).toMatchObject({
      provider: "openai",
      type: "api_key",
    });
    expect(qaStore.profiles["qa-mock-anthropic"]).toBeUndefined();

    await expect(
      lstat(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
    ).rejects.toThrow(/ENOENT/);
  });
});
