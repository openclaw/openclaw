import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../../doctor-contract-api.js";
import { setDiscordRuntime } from "../runtime.js";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
} from "./model-picker-preferences.js";

type DiscordRuntime = Parameters<typeof setDiscordRuntime>[0];

let stateDir: string;
let env: NodeJS.ProcessEnv;
const scope = { userId: "456" };
const record = (modelRef: string) => recordDiscordModelPickerRecentModel({ env, scope, modelRef });
const read = (options: { allowedModelRefs?: Set<string> } = {}) =>
  readDiscordModelPickerRecentModels({ env, scope, ...options });
const openStore = (namespace = "model-picker-preferences", maxEntries = 2_000) =>
  createPluginStateKeyedStoreForTests("discord", { namespace, maxEntries, env });

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-picker-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  setDiscordRuntime({
    state: {
      openKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests("discord", {
          ...options,
          env: options.env ?? env,
        }),
    },
  } as unknown as DiscordRuntime);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("discord model picker preferences", () => {
  it("records recent models in recency order without duplicates", async () => {
    const userScope = { userId: "123" };

    await recordDiscordModelPickerRecentModel({ env, scope: userScope, modelRef: "openai/gpt-4o" });
    await recordDiscordModelPickerRecentModel({
      env,
      scope: userScope,
      modelRef: "openai/gpt-4.1",
    });
    await recordDiscordModelPickerRecentModel({ env, scope: userScope, modelRef: "openai/gpt-4o" });

    const recent = await readDiscordModelPickerRecentModels({ env, scope: userScope });
    expect(recent).toEqual(["openai/gpt-4o", "openai/gpt-4.1"]);
  });

  it("filters recent models using an allowlist", async () => {
    await record("openai/gpt-4o");
    await record("openai/gpt-4.1");
    const allowedModelRefs = new Set(["openai/gpt-4.1"]);
    expect(await read({ allowedModelRefs })).toEqual(["openai/gpt-4.1"]);
  });

  it("prunes older stored models beyond the recent limit", async () => {
    const userScope = { userId: "limited-user" };
    for (const modelRef of [
      "openai/a",
      "openai/b",
      "openai/c",
      "openai/d",
      "openai/e",
      "openai/f",
    ]) {
      await recordDiscordModelPickerRecentModel({ env, scope: userScope, modelRef });
    }

    await expect(readDiscordModelPickerRecentModels({ env, scope: userScope })).resolves.toEqual([
      "openai/f",
      "openai/e",
      "openai/d",
      "openai/c",
      "openai/b",
    ]);
    const store = createPluginStateKeyedStoreForTests<unknown>("discord", {
      namespace: "model-picker-preferences",
      maxEntries: 2_000,
      env,
    });
    expect(await store.entries()).toHaveLength(5);
  });

  it("falls back to empty recents when stored state is malformed", async () => {
    const store = openStore();
    await record("openai/gpt-4.1");
    const [stored] = await store.entries();
    expect(stored).toBeDefined();
    await store.register(stored?.key ?? "missing", "not-an-entry");

    expect(await read()).toStrictEqual([]);
  });

  it("treats plugin-state failures as optional preference misses", async () => {
    setDiscordRuntime({
      state: {
        openKeyedStore: () => {
          throw new Error("state unavailable");
        },
      },
    } as unknown as DiscordRuntime);

    await expect(read()).resolves.toEqual([]);
    await expect(record("openai/gpt-4.1")).resolves.toBeUndefined();
  });

  it("preserves concurrent model picker selections for the same scope", async () => {
    await Promise.all([record("openai/gpt-4.1"), record("openai/gpt-4o")]);
    expect(new Set(await read())).toEqual(new Set(["openai/gpt-4o", "openai/gpt-4.1"]));
  });

  it("retires the July command cache while preserving July SQLite state", async () => {
    const migration = stateMigrations.find((entry) => entry.id === "discord-legacy-state")!;
    const input = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "credentials"),
      context: {
        openPluginStateKeyedStore: vi.fn(() => {
          throw new Error("cache retirement must not open canonical stores");
        }),
      },
    };
    const preferences = openStore();
    const bindings = openStore("thread-bindings", 10_000);
    const preference = {
      scopeKey: "discord:default:dm:user:123",
      modelRef: "openai/gpt-4.1",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const binding = {
      accountId: "default",
      channelId: "parent-1",
      threadId: "july-thread",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:july",
      agentId: "main",
      boundBy: "system",
      boundAt: 1_782_864_000_000,
      lastActivityAt: 1_782_864_000_000,
      idleTimeoutMs: 0,
      maxAgeMs: 0,
    };
    const preferenceKey = "v1:d5899e380e110de25e5bfcc71b9ea6c2:c8893463e7ced4209fdb0702";
    await preferences.register(preferenceKey, preference);
    await bindings.register("default:july-thread", binding);
    const sourcePath = path.join(input.stateDir, "discord", "command-deploy-cache.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "{malformed rebuildable cache");

    const result = await migration.migrateLegacyState(input);

    expect(result).toMatchObject({ warnings: [], changes: [expect.stringContaining(sourcePath)] });
    await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await preferences.lookup(preferenceKey)).toEqual(preference);
    expect(await bindings.lookup("default:july-thread")).toEqual(binding);
    expect(await migration.detectLegacyState(input)).toBeNull();
  });
});
