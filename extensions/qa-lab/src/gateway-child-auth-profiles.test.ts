import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function requireAuthProfile<T>(profiles: Record<string, T> | undefined, id: string): T {
  const profile = profiles?.[id];
  if (!profile) {
    throw new Error(`expected auth profile ${id}`);
  }
  return profile;
}

describe("QA Gateway auth profile staging", () => {
  it("stages a live Anthropic setup-token profile for isolated QA workers", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-setup-token-state-");
    const token = `sk-ant-oat01-${"c".repeat(80)}`;

    const cfg = await stageQaLiveAnthropicSetupToken({
      cfg: {},
      stateDir,
      env: {
        OPENCLAW_LIVE_SETUP_TOKEN_VALUE: token,
      },
    });

    const configProfile = requireAuthProfile(cfg.auth?.profiles, "anthropic:qa-setup-token");
    expect(configProfile.provider).toBe("anthropic");
    expect(configProfile.mode).toBe("token");
    const storeProfile = requireAuthProfile(
      readAuthProfileStore(stateDir, "main").profiles,
      "anthropic:qa-setup-token",
    );
    expect(storeProfile).toMatchObject({ type: "token", provider: "anthropic", token });
  });

  it.each([
    { source: "provider env", apiKey: undefined, env: { OPENAI_API_KEY: "qa-live-key" } },
    {
      source: "live alias",
      apiKey: undefined,
      env: { OPENCLAW_LIVE_CODEX_API_KEY: "qa-live-key" },
    },
    { source: "config literal", apiKey: "qa-live-key", env: {} },
  ])("stages $source API-key auth for isolated live QA workers", async ({ apiKey, env }) => {
    const stateDir = await tempDirs.makeTempDir("qa-live-api-key-state-");
    const cfg = await stageQaLiveApiKeyProfiles({
      cfg:
        apiKey === undefined
          ? {}
          : {
              models: { providers: { openai: { baseUrl: "", models: [], apiKey } } },
            },
      stateDir,
      providerIds: ["openai"],
      env,
    });
    expect(requireAuthProfile(cfg.auth?.profiles, "qa-live-openai-env")).toMatchObject({
      provider: "openai",
      mode: "api_key",
      displayName: "QA live openai env credential",
    });
    expect(Object.values(cfg.auth?.profiles ?? {})).not.toContainEqual(
      expect.objectContaining({ provider: "anthropic" }),
    );
    for (const agentId of ["main", "qa"]) {
      const profiles = readAuthProfileStore(stateDir, agentId).profiles;
      expect(requireAuthProfile(profiles, "qa-live-openai-env")).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "qa-live-key",
      });
      expect(Object.values(profiles)).not.toContainEqual(
        expect.objectContaining({ provider: "anthropic" }),
      );
    }
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env: {},
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("keeps the Codex API-key handoff out of profiles and maps it only into the gateway env", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-codex-handoff-state-");
    const baseEnv = { OPENCLAW_QA_CODEX_API_KEY_HANDOFF: "  synthetic-qa-api-key  " };
    const cfg = await stageQaLiveApiKeyProfiles({
      cfg: {},
      stateDir,
      providerIds: ["openai"],
      env: baseEnv,
    });

    expect(cfg.auth?.profiles).toBeUndefined();
    for (const agentId of ["main", "qa"]) {
      expect(readAuthProfileStore(stateDir, agentId).profiles).toEqual({});
    }
    const env = buildQaRuntimeEnv({
      configPath: "/tmp/openclaw-qa/openclaw.json",
      gatewayToken: "qa-token",
      homeDir: "/tmp/openclaw-qa/home",
      stateDir,
      tempRoot: "/tmp/openclaw-qa",
      xdgConfigHome: "/tmp/openclaw-qa/xdg-config",
      xdgDataHome: "/tmp/openclaw-qa/xdg-data",
      xdgCacheHome: "/tmp/openclaw-qa/xdg-cache",
      bundledPluginsDir: "/tmp/openclaw-qa/bundled-plugins",
      stagedBundledPluginsRoot: "/repo/.artifacts/qa-runtime/openclaw-qa-suite-test",
      compatibilityHostVersion: "2026.4.8",
      developmentSourceRoot: "/repo/openclaw",
      baseEnv,
      providerMode: "live-frontier",
    });
    expect(env.CODEX_API_KEY).toBe("synthetic-qa-api-key");
    expect(env).not.toHaveProperty("OPENCLAW_QA_CODEX_API_KEY_HANDOFF");
  });

  it("does not require Codex auth for custom OpenAI-compatible provider configs", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://proxy.example.test/v1",
                models: [],
              },
            },
          },
        },
        providerIds: ["openai"],
        env: {
          CODEX_HOME: path.join(os.tmpdir(), "missing-openclaw-codex-home"),
        },
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("accepts OpenAI API-key fallback auth for forced Codex runtime QA runs", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: {
          OPENCLAW_LIVE_OPENAI_KEY: "qa-live-codex-fallback-key",
          OPENCLAW_QA_FORCE_RUNTIME: "codex",
        },
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("stages mock profiles only for the requested agents and providers when callers override the defaults", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-mock-auth-override-");

    const cfg = await stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
      agentIds: ["qa"],
      providers: ["openai"],
    });

    const openaiConfigProfile = requireAuthProfile(cfg.auth?.profiles, "qa-mock-openai");
    expect(openaiConfigProfile.provider).toBe("openai");
    expect(openaiConfigProfile.mode).toBe("api_key");
    // Anthropic should NOT be staged when the caller restricts providers.
    expect(cfg.auth?.profiles?.["qa-mock-anthropic"]).toBeUndefined();

    const qaStore = readAuthProfileStore(stateDir, "qa");
    const openaiStoreProfile = requireAuthProfile(qaStore.profiles, "qa-mock-openai");
    expect(openaiStoreProfile.provider).toBe("openai");
    expect(openaiStoreProfile.type).toBe("api_key");
    expect(qaStore.profiles["qa-mock-anthropic"]).toBeUndefined();

    // The main agent's canonical database should not exist because it was not requested.
    await expect(
      lstat(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
    ).rejects.toThrow(/ENOENT/);
  });
});
