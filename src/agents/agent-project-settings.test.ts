/** Tests embedded agent project settings policy, merge behavior, and prepared managers. */
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
  createPreparedEmbeddedAgentSettingsManager,
} from "./agent-project-settings.js";
import { SettingsManager } from "./sessions/settings-manager.js";

async function withSettingsWorkspace(
  run: (params: {
    sessionId: string;
    cwd: string;
    agentDir: string;
    pluginMetadataSnapshot: ReturnType<typeof createPluginMetadataSnapshotFixture>;
  }) => Promise<void>,
): Promise<void> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-settings-"));
  const cwd = path.join(baseDir, "workspace");
  const agentDir = path.join(baseDir, "agent");
  try {
    await fs.mkdir(path.join(cwd, ".openclaw"), { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await run({
      sessionId: baseDir,
      cwd,
      agentDir,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
  } finally {
    clearPreparedEmbeddedAgentSettings([baseDir]);
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

describe("resolveEmbeddedAgentProjectSettingsPolicy", () => {
  it("defaults to sanitize", () => {
    expect(resolveEmbeddedAgentProjectSettingsPolicy()).toBe("sanitize");
  });
});

describe("buildEmbeddedAgentSettingsSnapshot", () => {
  const globalSettings = {
    shellPath: "/bin/zsh",
    compaction: { reserveTokens: 20_000, keepRecentTokens: 20_000 },
  };
  const projectSettings = {
    shellPath: "/tmp/evil-shell",
    shellCommandPrefix: "echo hacked &&",
    compaction: { reserveTokens: 32_000 },
    hideThinkingBlock: true,
  };

  it("applies sanitized plugin settings before project settings", () => {
    const snapshot = buildEmbeddedAgentSettingsSnapshot({
      globalSettings,
      pluginSettings: {
        shellPath: "/tmp/blocked-shell",
        compaction: { keepRecentTokens: 64_000 },
        hideThinkingBlock: false,
      },
      projectSettings,
      policy: "sanitize",
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });
});

describe("prepareAgentProviderRetryCount", () => {
  it.each([undefined, 0, 7])(
    "preserves released settings across preparation and an intentional write with count %s",
    async (maxRetries) => {
      await withSettingsWorkspace(async (params) => {
        // v2026.10.4 (383c124cc32ffee3f8e56f549b88da94d269a4af) stores these
        // canonical fields in two scopes; runtime preparation must never rewrite either file.
        const globalSettings = {
          theme: "dark",
          defaultProvider: "openai",
          shellPath: "/bin/sh",
          retry: {
            enabled: true,
            provider: {
              ...(maxRetries === undefined ? {} : { maxRetries: 2 }),
              timeoutMs: 45_000,
              maxRetryDelayMs: 12_000,
            },
          },
        };
        const projectSettings = {
          defaultModel: "gpt-5",
          hideThinkingBlock: true,
          retry: {
            provider: {
              ...(maxRetries === undefined ? {} : { maxRetries }),
              timeoutMs: 9_000,
              maxRetryDelayMs: 2_500,
            },
          },
        };
        const globalPath = path.join(params.agentDir, "settings.json");
        const projectPath = path.join(params.cwd, ".openclaw", "settings.json");
        const globalBytes = `${JSON.stringify(globalSettings, null, 2)}\n`;
        const projectBytes = `${JSON.stringify(projectSettings, null, 2)}\n`;
        await fs.writeFile(globalPath, globalBytes);
        await fs.writeFile(projectPath, projectBytes);
        const expectedProvider = { maxRetries, timeoutMs: 9_000, maxRetryDelayMs: 2_500 };
        const assertPrepared = (theme: string) => {
          // Native preparation runs first, so embedded preparation must reuse its frozen inputs.
          expect(prepareAgentProviderRetryCount(params)).toBe(maxRetries);
          const prepared = createPreparedEmbeddedAgentSettingsManager(params);
          expect(prepared.getProviderRetrySettings()).toEqual(expectedProvider);
          expect(prepared.getTheme()).toBe(theme);
          expect(prepared.getDefaultProvider()).toBe("openai");
          expect(prepared.getDefaultModel()).toBe("gpt-5");
          expect(prepared.getShellPath()).toBe("/bin/sh");
          expect(prepared.getHideThinkingBlock()).toBe(true);
          expect(prepared.getRetryEnabled()).toBe(false);
          return prepared;
        };
        const prepared = assertPrepared("dark");
        prepared.setTheme("attempt-only");
        prepared.setRetryEnabled(true);
        prepared.applyOverrides({ retry: { provider: { maxRetries: 99 } } });
        await prepared.flush();
        expect(await fs.readFile(globalPath, "utf8")).toBe(globalBytes);
        expect(await fs.readFile(projectPath, "utf8")).toBe(projectBytes);
        assertPrepared("dark");

        const persistent = SettingsManager.create(params.cwd, params.agentDir);
        persistent.setTheme("light");
        await persistent.flush();
        expect(JSON.parse(await fs.readFile(globalPath, "utf8"))).toEqual({
          ...globalSettings,
          theme: "light",
        });
        expect(await fs.readFile(projectPath, "utf8")).toBe(projectBytes);
        const reopened = SettingsManager.create(params.cwd, params.agentDir);
        expect(reopened.getTheme()).toBe("light");
        expect(reopened.getProviderRetrySettings()).toEqual(expectedProvider);
        expect(reopened.getGlobalSettings()).toEqual({ ...globalSettings, theme: "light" });
        expect(reopened.getProjectSettings()).toEqual(projectSettings);
        assertPrepared("dark");
        clearPreparedEmbeddedAgentSettings([params.sessionId]);
        assertPrepared("light");
      });
    },
  );

  it.each([undefined, 0, 1, 4])("projects only the explicit count %s", async (maxRetries) => {
    await withSettingsWorkspace(async (params) => {
      await fs.writeFile(
        path.join(params.agentDir, "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries } } }),
      );
      expect(prepareAgentProviderRetryCount(params)).toBe(maxRetries);
      // Sharing the snapshot must not remove the embedded manager's existing delay default.
      expect(createPreparedEmbeddedAgentSettingsManager(params).getProviderRetrySettings()).toEqual(
        { maxRetries, timeoutMs: undefined, maxRetryDelayMs: 60_000 },
      );
    });
  });

  it.each(["trusted", "sanitize", "ignore"] as const)(
    "keeps %s precedence, frozen file inputs and explicit invalidation",
    async (policy) => {
      await withSettingsWorkspace(async (params) => {
        const pluginRoot = path.join(params.cwd, "bundle");
        await fs.mkdir(pluginRoot);
        await fs.writeFile(
          path.join(params.agentDir, "settings.json"),
          JSON.stringify({ retry: { provider: { maxRetries: 4 } } }),
        );
        await fs.writeFile(
          path.join(pluginRoot, "settings.json"),
          JSON.stringify({ retry: { provider: { maxRetries: 1 } } }),
        );
        const projectPath = path.join(params.cwd, ".openclaw", "settings.json");
        await fs.writeFile(projectPath, JSON.stringify({ retry: { provider: { maxRetries: 0 } } }));
        const input = {
          ...params,
          cfg: {
            agents: { defaults: { embeddedAgent: { projectSettingsPolicy: policy } } },
            plugins: { entries: { "retry-bundle": { enabled: true } } },
          },
          pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "retry-bundle",
                rootDir: pluginRoot,
                format: "bundle",
                settingsFiles: ["settings.json"],
              },
            ],
          }),
        };
        expect(prepareAgentProviderRetryCount(input)).toBe(policy === "ignore" ? 1 : 0);
        await fs.writeFile(projectPath, JSON.stringify({ retry: { provider: { maxRetries: 2 } } }));
        expect(prepareAgentProviderRetryCount(input)).toBe(policy === "ignore" ? 1 : 0);
        clearPreparedEmbeddedAgentSettings([params.sessionId]);
        expect(prepareAgentProviderRetryCount(input)).toBe(policy === "ignore" ? 1 : 2);
      });
    },
  );

  it("does not admit embedded retired settings, compaction or delay policy into native setup", async () => {
    await withSettingsWorkspace(async (params) => {
      await fs.writeFile(
        path.join(params.agentDir, "settings.json"),
        JSON.stringify({
          queueMode: "all",
          httpIdleTimeoutMs: "invalid for embedded",
          compaction: { reserveTokens: -1 },
          retry: { provider: { maxRetries: 0, maxRetryDelayMs: 5, timeoutMs: 9 } },
        }),
      );
      expect(prepareAgentProviderRetryCount(params)).toBe(0);
      expect(() => createPreparedEmbeddedAgentSettingsManager(params)).toThrow(
        "queueMode: use steeringMode",
      );
    });
  });
});

describe("createPreparedEmbeddedAgentSettingsManager", () => {
  it.each([
    { policy: "trusted", shellCommandPrefix: "echo trusted &&", reserveTokens: 32_000 },
    { policy: "sanitize", shellCommandPrefix: "echo global &&", reserveTokens: 32_000 },
    { policy: "ignore", shellCommandPrefix: "echo global &&", reserveTokens: 22_000 },
  ] as const)(
    "reuses $policy settings until reset without persisting attempt changes",
    async (testCase) => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-settings-"));
      try {
        const cwd = path.join(baseDir, "workspace");
        const agentDir = path.join(baseDir, "agent");
        const projectSettingsDir = path.join(cwd, ".openclaw");
        const agentSettingsPath = path.join(agentDir, "settings.json");
        await fs.mkdir(projectSettingsDir, { recursive: true });
        await fs.mkdir(agentDir, { recursive: true });
        const globalSettings = {
          retry: { enabled: true },
          shellCommandPrefix: "echo global &&",
          compaction: { reserveTokens: 22_000, keepRecentTokens: 23_000 },
        };
        await fs.writeFile(agentSettingsPath, JSON.stringify(globalSettings, null, 2), "utf8");
        await fs.writeFile(
          path.join(projectSettingsDir, "settings.json"),
          JSON.stringify({
            shellCommandPrefix: "echo trusted &&",
            compaction: { reserveTokens: 32_000 },
          }),
          "utf8",
        );

        const params = {
          sessionId: baseDir,
          cwd,
          agentDir,
          pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
          cfg: {
            agents: { defaults: { embeddedAgent: { projectSettingsPolicy: testCase.policy } } },
          },
        };
        const settingsManager = createPreparedEmbeddedAgentSettingsManager(params);

        expect(settingsManager.getShellCommandPrefix()).toBe(testCase.shellCommandPrefix);
        expect(settingsManager.getCompactionReserveTokens()).toBe(testCase.reserveTokens);
        expect(settingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
        expect(settingsManager.getRetryEnabled()).toBe(false);
        settingsManager.applyOverrides({ compaction: { reserveTokens: 90_000 } });
        settingsManager.setRetryEnabled(true);

        await settingsManager.flush();

        expect(JSON.parse(await fs.readFile(agentSettingsPath, "utf8"))).toEqual(globalSettings);

        await fs.writeFile(
          agentSettingsPath,
          JSON.stringify({
            ...globalSettings,
            compaction: { ...globalSettings.compaction, keepRecentTokens: 45_000 },
          }),
        );
        await settingsManager.reload();
        expect(settingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
        const nextSettingsManager = createPreparedEmbeddedAgentSettingsManager(params);
        expect(nextSettingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
        expect(nextSettingsManager.getCompactionReserveTokens()).toBe(testCase.reserveTokens);
        expect(nextSettingsManager.getRetryEnabled()).toBe(false);
        await nextSettingsManager.flush();
        clearPreparedEmbeddedAgentSettings([params.sessionId]);
        expect(
          createPreparedEmbeddedAgentSettingsManager(params).getCompactionKeepRecentTokens(),
        ).toBe(45_000);
      } finally {
        clearPreparedEmbeddedAgentSettings([baseDir]);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["published", "scoped"])(
    "refreshes project policy after %s config changes",
    async (mode) => {
      await withSettingsWorkspace(async (params) => {
        const cfg: OpenClawConfig = {
          agents: { defaults: { embeddedAgent: { projectSettingsPolicy: "sanitize" } } },
        };
        await fs.writeFile(
          path.join(params.agentDir, "settings.json"),
          JSON.stringify({ shellCommandPrefix: "global" }),
        );
        await fs.writeFile(
          path.join(params.cwd, ".openclaw", "settings.json"),
          JSON.stringify({ shellCommandPrefix: "project" }),
        );
        try {
          if (mode === "published") {
            setRuntimeConfigSnapshot(cfg);
          }
          expect(
            createPreparedEmbeddedAgentSettingsManager({ ...params, cfg }).getShellCommandPrefix(),
          ).toBe("global");

          cfg.agents = { defaults: { embeddedAgent: { projectSettingsPolicy: "trusted" } } };
          if (mode === "published") {
            setRuntimeConfigSnapshot(cfg);
          }
          expect(
            createPreparedEmbeddedAgentSettingsManager({ ...params, cfg }).getShellCommandPrefix(),
          ).toBe("project");
        } finally {
          if (mode === "published") {
            clearRuntimeConfigSnapshot();
          }
        }
      });
    },
  );

  it("refreshes settings after plugin replacement and process lifecycle reset", async () => {
    await withSettingsWorkspace(async (params) => {
      const pluginRoot = path.join(params.cwd, "bundle");
      await fs.mkdir(pluginRoot);
      const pluginSettingsPath = path.join(pluginRoot, "settings.json");
      const createSnapshot = (cache: ReturnType<typeof createPluginCache>) =>
        withPluginCache(cache, () =>
          createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "settings-bundle",
                rootDir: pluginRoot,
                format: "bundle",
                settingsFiles: ["settings.json"],
              },
            ],
          }),
        );
      await using initialCache = createPluginCache();
      await using replacementCache = createPluginCache();
      const initial = {
        ...params,
        cfg: { plugins: { entries: { "settings-bundle": { enabled: true } } } },
        pluginMetadataSnapshot: createSnapshot(initialCache),
      };
      await fs.writeFile(
        pluginSettingsPath,
        JSON.stringify({ compaction: { keepRecentTokens: 25_000 } }),
      );
      expect(
        createPreparedEmbeddedAgentSettingsManager(initial).getCompactionKeepRecentTokens(),
      ).toBe(25_000);

      await fs.writeFile(
        pluginSettingsPath,
        JSON.stringify({ compaction: { keepRecentTokens: 35_000 } }),
      );
      const replacement = {
        ...initial,
        pluginMetadataSnapshot: createSnapshot(replacementCache),
      };
      expect(
        createPreparedEmbeddedAgentSettingsManager(replacement).getCompactionKeepRecentTokens(),
      ).toBe(35_000);

      await fs.writeFile(
        path.join(params.agentDir, "settings.json"),
        JSON.stringify({ shellCommandPrefix: "refreshed global prefix" }),
      );
      clearPluginMetadataLifecycleCaches();
      expect(createPreparedEmbeddedAgentSettingsManager(replacement).getShellCommandPrefix()).toBe(
        "refreshed global prefix",
      );
    });
  });

  it("keeps workspace and agent settings scoped when a session moves", async () => {
    await withSettingsWorkspace(async (params) => {
      await fs.writeFile(
        path.join(params.agentDir, "settings.json"),
        JSON.stringify({ compaction: { reserveTokens: 25_000 } }),
      );
      await fs.writeFile(
        path.join(params.cwd, ".openclaw", "settings.json"),
        JSON.stringify({ compaction: { keepRecentTokens: 30_000 } }),
      );
      const original = createPreparedEmbeddedAgentSettingsManager(params);
      expect(original.getCompactionReserveTokens()).toBe(25_000);
      expect(original.getCompactionKeepRecentTokens()).toBe(30_000);

      const cwd = path.join(params.cwd, "second-workspace");
      await fs.mkdir(path.join(cwd, ".openclaw"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".openclaw", "settings.json"),
        JSON.stringify({ compaction: { keepRecentTokens: 40_000 } }),
      );
      expect(
        createPreparedEmbeddedAgentSettingsManager({
          ...params,
          cwd,
        }).getCompactionKeepRecentTokens(),
      ).toBe(40_000);

      const agentDir = path.join(params.agentDir, "second-agent");
      await fs.mkdir(agentDir);
      await fs.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ compaction: { reserveTokens: 35_000 } }),
      );
      const moved = createPreparedEmbeddedAgentSettingsManager({ ...params, cwd, agentDir });
      expect(moved.getCompactionReserveTokens()).toBe(35_000);
      expect(moved.getCompactionKeepRecentTokens()).toBe(40_000);
    });
  });

  it("recomputes model compaction limits without narrowing the reusable settings", async () => {
    await withSettingsWorkspace(async (params) => {
      await fs.writeFile(
        path.join(params.agentDir, "settings.json"),
        JSON.stringify({ compaction: { reserveTokens: 32_000 } }),
      );
      for (const [contextTokenBudget, reserveTokens] of [
        [8_000, 2_000],
        [128_000, 32_000],
        [8_000, 2_000],
      ] as const) {
        expect(
          createPreparedEmbeddedAgentSettingsManager({
            ...params,
            contextTokenBudget,
          }).getCompactionReserveTokens(),
        ).toBe(reserveTokens);
      }
    });
  });
});
