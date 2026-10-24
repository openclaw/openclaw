import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareAgentProviderRetryCount } from "./agent-project-settings-prepared.js";
import {
  buildEmbeddedAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
} from "./agent-project-settings-snapshot.js";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager as prepare,
} from "./agent-project-settings.js";

const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const retryProvider = (
  maxRetries: number | undefined,
  timeoutMs = 9_000,
  maxRetryDelayMs = 2_500,
) => ({
  ...(maxRetries === undefined ? {} : { maxRetries }),
  timeoutMs,
  maxRetryDelayMs,
});
const bundleSnapshot = (rootDir: string, id: string) =>
  createPluginMetadataSnapshotFixture({
    plugins: [{ id, rootDir, format: "bundle", settingsFiles: ["settings.json"] }],
  });

async function createSettingsWorkspace() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-settings-"));
  const cwd = path.join(baseDir, "workspace");
  const agentDir = path.join(baseDir, "agent");
  await fs.mkdir(path.join(cwd, ".openclaw"), { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  return {
    sessionId: baseDir,
    cwd,
    agentDir,
    globalPath: path.join(agentDir, "settings.json"),
    projectPath: path.join(cwd, ".openclaw", "settings.json"),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    async [Symbol.asyncDispose]() {
      clearPreparedEmbeddedAgentSettings([baseDir]);
      await fs.rm(baseDir, { recursive: true, force: true });
    },
  };
}

it("defaults project settings policy to sanitize", () => {
  expect(resolveEmbeddedAgentProjectSettingsPolicy()).toBe("sanitize");
});

it("applies admitted plugin settings before project settings", () => {
  const snapshot = buildEmbeddedAgentSettingsSnapshot({
    globalSettings: {
      shellPath: "/bin/zsh",
      compaction: { reserveTokens: 20_000, keepRecentTokens: 20_000 },
    },
    pluginSettings: {
      compaction: { keepRecentTokens: 64_000 },
      hideThinkingBlock: false,
    },
    projectSettings: {
      shellPath: "/tmp/evil-shell",
      shellCommandPrefix: "echo hacked &&",
      compaction: { reserveTokens: 32_000 },
      hideThinkingBlock: true,
    },
    policy: "sanitize",
  });
  expect([snapshot.shellPath, snapshot.shellCommandPrefix]).toEqual(["/bin/zsh", undefined]);
  expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
  expect(snapshot.compaction?.reserveTokens).toBe(32_000);
  expect(snapshot.hideThinkingBlock).toBe(true);
});

it.each([undefined, 0, 7])("preserves stored settings (%s)", async (maxRetries) => {
  await using params = await createSettingsWorkspace();
  // Preserve both v2026.10.4 scopes (383c124cc32ffee3f8e56f549b88da94d269a4af).
  const globalSettings = {
    theme: "dark",
    defaultProvider: "openai",
    defaultThinkingLevel: "low",
    shellPath: "/bin/sh",
    retry: {
      enabled: true,
      provider: retryProvider(maxRetries === undefined ? undefined : 2, 45_000, 12_000),
    },
  };
  const projectSettings = {
    defaultModel: "gpt-5",
    hideThinkingBlock: true,
    retry: { provider: retryProvider(maxRetries) },
  };
  const { globalPath, projectPath } = params;
  const globalBytes = `${JSON.stringify(globalSettings, null, 2)}\n`;
  const projectBytes = `${JSON.stringify(projectSettings, null, 2)}\n`;
  await fs.writeFile(globalPath, globalBytes);
  await fs.writeFile(projectPath, projectBytes);
  const expectedProvider = { maxRetries, timeoutMs: 9_000, maxRetryDelayMs: 2_500 };
  const assertPrepared = (thinkingLevel: string) => {
    // Native preparation runs first, so embedded preparation must reuse its frozen inputs.
    expect(prepareAgentProviderRetryCount(params)).toBe(maxRetries);
    const prepared = prepare(params);
    expect(prepared.getProviderRetrySettings()).toEqual(expectedProvider);
    expect(prepared.getGlobalSettings()).toMatchObject({
      theme: "dark",
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      shellPath: "/bin/sh",
      hideThinkingBlock: true,
    });
    expect(prepared.getDefaultThinkingLevel()).toBe(thinkingLevel);
    expect(prepared.getRetryEnabled()).toBe(false);
    return prepared;
  };
  const prepared = assertPrepared("low");
  prepared.setDefaultThinkingLevel("high");
  prepared.setRetryEnabled(true);
  prepared.applyOverrides({ retry: { provider: { maxRetries: 99 } } });
  expect(await fs.readFile(globalPath, "utf8")).toBe(globalBytes);
  expect(await fs.readFile(projectPath, "utf8")).toBe(projectBytes);
  assertPrepared("low");

  await writeJson(globalPath, { ...globalSettings, defaultThinkingLevel: "high" });
  expect(JSON.parse(await fs.readFile(globalPath, "utf8"))).toEqual({
    ...globalSettings,
    defaultThinkingLevel: "high",
  });
  expect(await fs.readFile(projectPath, "utf8")).toBe(projectBytes);
  assertPrepared("low");
  clearPreparedEmbeddedAgentSettings([params.sessionId]);
  assertPrepared("high");
});

it.each([undefined, 0, 1, 4])("projects only the explicit count %s", async (maxRetries) => {
  await using params = await createSettingsWorkspace();
  await writeJson(params.globalPath, { retry: { provider: { maxRetries } } });
  expect(prepareAgentProviderRetryCount(params)).toBe(maxRetries);
  // Sharing the snapshot must not remove the embedded manager's existing delay default.
  expect(prepare(params).getProviderRetrySettings()).toEqual({
    maxRetries,
    timeoutMs: undefined,
    maxRetryDelayMs: 60_000,
  });
});

it("does not admit embedded retired settings, compaction or delay policy into native setup", async () => {
  await using params = await createSettingsWorkspace();
  await writeJson(params.globalPath, {
    queueMode: "all",
    httpIdleTimeoutMs: "invalid for embedded",
    compaction: { reserveTokens: -1 },
    retry: { provider: { maxRetries: 0, maxRetryDelayMs: 5, timeoutMs: 9 } },
  });
  expect(prepareAgentProviderRetryCount(params)).toBe(0);
  expect(() => prepare(params)).toThrow("queueMode: use steeringMode");
});
describe("createPreparedEmbeddedAgentSettingsManager", () => {
  it.each(
    [
      {
        retired: { queueMode: "all" },
        canonical: { steeringMode: "all" },
        guidance: "steeringMode",
      },
      { retired: { websockets: false }, canonical: { transport: "sse" }, guidance: "transport" },
      {
        retired: { skills: { customDirectories: ["custom-skill"], enableSkillCommands: false } },
        canonical: { skills: ["custom-skill"], enableSkillCommands: false },
        guidance: "enableSkillCommands",
      },
      {
        retired: { retry: { maxDelayMs: 12_000 } },
        canonical: { retry: { provider: { maxRetryDelayMs: 12_000 } } },
        guidance: "retry.provider.maxRetryDelayMs",
      },
    ].flatMap((settings) => [
      { ...settings, scope: "global" as const },
      { ...settings, scope: "project" as const },
    ]),
  )(
    "refuses retired $scope settings with $guidance guidance and preserves bytes",
    async ({ retired, canonical, guidance, scope }) => {
      await using params = await createSettingsWorkspace();
      const settingsPath = scope === "global" ? params.globalPath : params.projectPath;
      const original = `${JSON.stringify({ theme: "keep", ...retired }, null, 4)}\n`;
      await fs.writeFile(settingsPath, original);
      const refusal = expect.objectContaining({
        code: "INVALID_CONFIG",
        recovery: "manual",
        message: expect.stringContaining(guidance),
      });
      expect(() => prepare(params)).toThrowError(refusal);
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);

      await writeJson(settingsPath, canonical);
      expect(prepare(params).getGlobalSettings()).toMatchObject(canonical);
      await fs.writeFile(settingsPath, original);
      clearPreparedEmbeddedAgentSettings([params.sessionId]);
      expect(() => prepare(params)).toThrowError(refusal);
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    },
  );

  it.each([
    { policy: "trusted", shellCommandPrefix: "echo trusted &&", reserveTokens: 32_000 },
    { policy: "sanitize", shellCommandPrefix: "echo global &&", reserveTokens: 32_000 },
    { policy: "ignore", shellCommandPrefix: "echo global &&", reserveTokens: 22_000 },
  ] as const)(
    "keeps $policy settings frozen until reset without persisting attempts",
    async (testCase) => {
      await using params = await createSettingsWorkspace();
      const { globalPath, projectPath } = params;
      const pluginRoot = path.join(params.cwd, "bundle");
      const globalSettings = {
        retry: { enabled: true, provider: { maxRetries: 4 } },
        shellCommandPrefix: "echo global &&",
        compaction: { reserveTokens: 22_000, keepRecentTokens: 23_000 },
      };
      const projectSettings = {
        retry: { provider: { maxRetries: 0 } },
        shellCommandPrefix: "echo trusted &&",
        compaction: { reserveTokens: 32_000 },
      };
      await fs.mkdir(pluginRoot);
      await writeJson(globalPath, globalSettings);
      await writeJson(projectPath, projectSettings);
      await writeJson(path.join(pluginRoot, "settings.json"), {
        retry: { provider: { maxRetries: 1 } },
      });
      const input = {
        ...params,
        cfg: {
          agents: { defaults: { embeddedAgent: { projectSettingsPolicy: testCase.policy } } },
          plugins: { entries: { "retry-bundle": { enabled: true } } },
        },
        pluginMetadataSnapshot: bundleSnapshot(pluginRoot, "retry-bundle"),
      };
      expect(prepareAgentProviderRetryCount(input)).toBe(testCase.policy === "ignore" ? 1 : 0);
      const settingsManager = prepare(input);
      expect(settingsManager.getGlobalSettings().shellCommandPrefix).toBe(
        testCase.shellCommandPrefix,
      );
      expect(settingsManager.getCompactionReserveTokens()).toBe(testCase.reserveTokens);
      expect(settingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
      expect(settingsManager.getRetryEnabled()).toBe(false);
      settingsManager.applyOverrides({ compaction: { reserveTokens: 90_000 } });
      settingsManager.setRetryEnabled(true);
      expect(JSON.parse(await fs.readFile(globalPath, "utf8"))).toEqual(globalSettings);

      await writeJson(projectPath, {
        ...projectSettings,
        retry: { provider: { maxRetries: 2 } },
      });
      await writeJson(globalPath, {
        ...globalSettings,
        compaction: { ...globalSettings.compaction, keepRecentTokens: 45_000 },
      });
      expect(prepareAgentProviderRetryCount(input)).toBe(testCase.policy === "ignore" ? 1 : 0);
      expect(settingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
      const nextSettingsManager = prepare(input);
      expect(nextSettingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
      expect(nextSettingsManager.getCompactionReserveTokens()).toBe(testCase.reserveTokens);
      expect(nextSettingsManager.getRetryEnabled()).toBe(false);
      clearPreparedEmbeddedAgentSettings([params.sessionId]);
      expect(prepareAgentProviderRetryCount(input)).toBe(testCase.policy === "ignore" ? 1 : 2);
      expect(prepare(input).getCompactionKeepRecentTokens()).toBe(45_000);
    },
  );

  it.each(["published", "scoped"])("refreshes %s config policy", async (mode) => {
    await using params = await createSettingsWorkspace();
    const cfg: OpenClawConfig = {};
    await writeJson(params.globalPath, { shellCommandPrefix: "global" });
    await writeJson(params.projectPath, { shellCommandPrefix: "project" });
    try {
      for (const [policy, prefix] of [
        ["sanitize", "global"],
        ["trusted", "project"],
      ] as const) {
        cfg.agents = { defaults: { embeddedAgent: { projectSettingsPolicy: policy } } };
        if (mode === "published") {
          setRuntimeConfigSnapshot(cfg);
        }
        expect(prepare({ ...params, cfg }).getGlobalSettings().shellCommandPrefix).toBe(prefix);
      }
    } finally {
      if (mode === "published") {
        clearRuntimeConfigSnapshot();
      }
    }
  });

  it("refreshes settings after plugin replacement and process lifecycle reset", async () => {
    await using params = await createSettingsWorkspace();
    const pluginRoot = path.join(params.cwd, "bundle");
    await fs.mkdir(pluginRoot);
    const pluginSettingsPath = path.join(pluginRoot, "settings.json");
    const createSnapshot = (cache: ReturnType<typeof createPluginCache>) =>
      withPluginCache(cache, () => bundleSnapshot(pluginRoot, "settings-bundle"));
    await using initialCache = createPluginCache();
    await using replacementCache = createPluginCache();
    const initial = {
      ...params,
      cfg: { plugins: { entries: { "settings-bundle": { enabled: true } } } },
      pluginMetadataSnapshot: createSnapshot(initialCache),
    };
    await writeJson(pluginSettingsPath, { compaction: { keepRecentTokens: 25_000 } });
    expect(prepare(initial).getCompactionKeepRecentTokens()).toBe(25_000);

    await writeJson(pluginSettingsPath, { compaction: { keepRecentTokens: 35_000 } });
    const replacement = {
      ...initial,
      pluginMetadataSnapshot: createSnapshot(replacementCache),
    };
    expect(prepare(replacement).getCompactionKeepRecentTokens()).toBe(35_000);

    await writeJson(params.globalPath, { shellCommandPrefix: "refreshed global prefix" });
    clearPluginMetadataLifecycleCaches();
    expect(prepare(replacement).getGlobalSettings().shellCommandPrefix).toBe(
      "refreshed global prefix",
    );
  });

  it("keeps workspace and agent settings scoped when a session moves", async () => {
    await using params = await createSettingsWorkspace();
    await writeJson(params.globalPath, { compaction: { reserveTokens: 25_000 } });
    await writeJson(params.projectPath, { compaction: { keepRecentTokens: 30_000 } });
    const original = prepare(params);
    expect(original.getCompactionReserveTokens()).toBe(25_000);
    expect(original.getCompactionKeepRecentTokens()).toBe(30_000);

    const cwd = path.join(params.cwd, "second-workspace");
    await fs.mkdir(path.join(cwd, ".openclaw"), { recursive: true });
    await writeJson(path.join(cwd, ".openclaw", "settings.json"), {
      compaction: { keepRecentTokens: 40_000 },
    });
    expect(prepare({ ...params, cwd }).getCompactionKeepRecentTokens()).toBe(40_000);

    const agentDir = path.join(params.agentDir, "second-agent");
    await fs.mkdir(agentDir);
    await writeJson(path.join(agentDir, "settings.json"), {
      compaction: { reserveTokens: 35_000 },
    });
    const moved = prepare({ ...params, cwd, agentDir });
    expect(moved.getCompactionReserveTokens()).toBe(35_000);
    expect(moved.getCompactionKeepRecentTokens()).toBe(40_000);
  });

  it("recomputes model compaction limits without narrowing the reusable settings", async () => {
    await using params = await createSettingsWorkspace();
    await writeJson(params.globalPath, { compaction: { reserveTokens: 32_000 } });
    for (const [contextTokenBudget, reserveTokens] of [
      [8_000, 2_000],
      [128_000, 32_000],
      [8_000, 2_000],
    ] as const) {
      expect(prepare({ ...params, contextTokenBudget }).getCompactionReserveTokens()).toBe(
        reserveTokens,
      );
    }
  });
});
