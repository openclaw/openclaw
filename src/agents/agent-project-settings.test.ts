/** Tests embedded agent project settings policy, merge behavior, and prepared managers. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
} from "./agent-project-settings-snapshot.js";
import { createPreparedEmbeddedAgentSettingsManager } from "./agent-project-settings.js";

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
    "keeps $policy file-backed settings runtime-scoped after preparation",
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
          cwd,
          agentDir,
          cfg: {
            agents: { defaults: { embeddedAgent: { projectSettingsPolicy: testCase.policy } } },
          },
        };
        const settingsManager = createPreparedEmbeddedAgentSettingsManager(params);

        expect(settingsManager.getShellCommandPrefix()).toBe(testCase.shellCommandPrefix);
        expect(settingsManager.getCompactionReserveTokens()).toBe(testCase.reserveTokens);
        expect(settingsManager.getCompactionKeepRecentTokens()).toBe(23_000);
        expect(settingsManager.getRetryEnabled()).toBe(false);

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
        expect(settingsManager.getRetryEnabled()).toBe(false);
        const nextSettingsManager = createPreparedEmbeddedAgentSettingsManager(params);
        expect(nextSettingsManager.getCompactionKeepRecentTokens()).toBe(45_000);
        await nextSettingsManager.flush();
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    },
  );
});
