import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDiscordModelPickerRecentModels } from "./monitor/model-picker-preferences.js";
import { createThreadBindingManager, __testing } from "./monitor/thread-bindings.manager.js";
import { detectDiscordLegacyStateMigrations } from "./state-migrations.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "./test-support/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  __testing.resetThreadBindingsForTests();
  resetPluginStateStoreForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Discord legacy state migrations", () => {
  it("imports model-picker preferences into plugin state and removes the JSON file", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-migrate-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const preferencesPath = path.join(stateDir, "discord", "model-picker-preferences.json");
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
    fs.writeFileSync(
      preferencesPath,
      `${JSON.stringify(
        {
          version: 1,
          entries: {
            "discord:default:dm:user:123": {
              recent: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.6"],
              updatedAt: "2026-05-07T09:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const plans = detectDiscordLegacyStateMigrations({ stateDir });
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (!plan || plan.kind !== "custom") {
      throw new Error("missing Discord model-picker migration plan");
    }

    const result = await plan.apply({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
    });

    expect(result.changes.join("\n")).toContain("Imported 1 Discord model-picker preferences");
    await expect(
      readDiscordModelPickerRecentModels({
        scope: { userId: "123" },
      }),
    ).resolves.toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4.6"]);
    expect(fs.existsSync(preferencesPath)).toBe(false);
  });

  it("imports thread bindings into plugin state and removes the JSON file", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-migrate-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const bindingsPath = path.join(stateDir, "discord", "thread-bindings.json");
    fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
    const boundAt = Date.now() - 10_000;
    const expiresAt = boundAt + 60_000;
    fs.writeFileSync(
      bindingsPath,
      `${JSON.stringify(
        {
          version: 1,
          bindings: {
            "default:thread-legacy": {
              accountId: "default",
              channelId: "parent-1",
              threadId: "thread-legacy",
              targetKind: "subagent",
              targetSessionKey: "agent:main:subagent:legacy",
              agentId: "main",
              boundBy: "system",
              boundAt,
              expiresAt,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const plans = detectDiscordLegacyStateMigrations({ stateDir });
    expect(plans.map((plan) => plan.label)).toContain("Discord thread bindings");
    const plan = plans.find((entry) => entry.label === "Discord thread bindings");
    if (!plan || plan.kind !== "custom") {
      throw new Error("missing Discord thread-binding migration plan");
    }

    const result = await plan.apply({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
    });

    expect(result.changes.join("\n")).toContain("Imported 1 Discord thread bindings");
    __testing.resetThreadBindingsForTests({ clearStore: false });
    const manager = createThreadBindingManager({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const binding = manager.getByThreadId("thread-legacy");
    expect(binding?.maxAgeMs).toBe(expiresAt - boundAt);
    expect(binding?.idleTimeoutMs).toBe(0);
    expect(fs.existsSync(bindingsPath)).toBe(false);
  });
});
