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
import {
  buildEmbeddedAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
} from "./agent-project-settings-snapshot.js";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager,
} from "./agent-project-settings.js";

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
