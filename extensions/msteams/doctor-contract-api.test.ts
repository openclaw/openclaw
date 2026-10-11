import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import {
  MSTEAMS_DELEGATED_TOKEN_KEY,
  MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
  MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
} from "./src/delegated-token-contract.js";
import type { MSTeamsDelegatedTokens } from "./src/oauth.shared.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("msteams", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

describe("msteams doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-doctor-")),
    );
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "conversations",
      file: "msteams-conversations.json",
      source: { version: 1, conversations: { old: { conversation: { id: "old" } } } },
    },
    {
      name: "polls",
      file: "msteams-polls.json",
      source: {
        version: 1,
        polls: {
          old: {
            id: "old",
            question: "Lunch?",
            options: ["Pizza", "Sushi"],
            maxSelections: 1,
            createdAt: "2026-05-01T00:00:00.000Z",
            votes: {},
          },
        },
      },
    },
    {
      name: "sso-tokens",
      file: "msteams-sso-tokens.json",
      source: {
        version: 1,
        tokens: {
          old: {
            connectionName: "connection",
            userId: "user",
            token: "synthetic-token",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        },
      },
    },
    {
      name: "feedback-learnings",
      file: `sessions/${Buffer.from("agent:main:msteams:synthetic").toString("base64url")}.learnings.json`,
      source: ["Use concise replies"],
    },
  ])(
    "preserves retired $name files and requires the bridge release",
    async ({ name, file, source }) => {
      const migration = migrationById(`msteams-${name}-json-to-plugin-state`);
      const params = {
        config: { session: { store: path.join(stateDir, "sessions") } },
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      };
      expect(await migration.collectBackupResources?.(params)).toEqual([]);
      await expect(migration.detectLegacyState(params)).resolves.toBeNull();
      const filePath = path.join(stateDir, file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const original = JSON.stringify(source);
      await fs.writeFile(filePath, original);

      await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
        preview: [expect.stringContaining("2026.9.5")],
      });
      await expect(migration.migrateLegacyState(params)).resolves.toEqual({
        changes: [],
        warnings: [expect.stringContaining("2026.9.5")],
      });
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(original);
      await expect(
        fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["empty", "collision", "blocked", "relative-symlink"])(
    "imports delegated OAuth tokens before archiving (archive=%s)",
    async (archive) => {
      const filePath = path.join(stateDir, "msteams-delegated.json");
      const token: MSTeamsDelegatedTokens = {
        accessToken: "delegated-access",
        refreshToken: "delegated-refresh",
        expiresAt: 1_800_000_000_000,
        scopes: ["User.Read", "offline_access"],
        userPrincipalName: "user@example.com",
      };
      if (archive === "relative-symlink") {
        await fs.writeFile(path.join(stateDir, "tokens.json"), JSON.stringify(token));
        await fs.symlink("tokens.json", filePath);
      } else {
        await fs.writeFile(filePath, JSON.stringify(token));
      }
      const archiveDirectory = `${filePath}.archives`;
      const archiveBase = path.join(archiveDirectory, "msteams-delegated.json");
      await fs.writeFile(`${filePath}.migrated`, "old root archive");
      await fs.writeFile(`${filePath}.migrated.2`, "old root collision");
      if (archive === "collision") {
        await fs.mkdir(archiveDirectory);
        await fs.writeFile(`${archiveBase}.migrated`, "earlier archive");
        await fs.writeFile(`${archiveBase}.migrated.2`, "another earlier archive");
      } else if (archive === "blocked") {
        await fs.writeFile(archiveDirectory, "not a directory");
      }
      const migration = migrationById("msteams-delegated-token-json-to-plugin-state");
      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };

      await expect(migration.detectLegacyState(params)).resolves.toEqual({
        preview: [
          `- Microsoft Teams delegated OAuth token -> plugin state (${MSTEAMS_DELEGATED_TOKEN_NAMESPACE})`,
        ],
      });
      const before = (await fs.readdir(stateDir, { recursive: true })).toSorted();
      expect(await migration.collectBackupResources?.(params)).toEqual([
        { path: filePath, kind: "file" },
        { path: archiveDirectory, kind: "directory" },
      ]);
      expect((await fs.readdir(stateDir, { recursive: true })).toSorted()).toEqual(before);
      expect(await fs.readFile(filePath, "utf8")).toBe(JSON.stringify(token));
      const result = await migration.migrateLegacyState(params);

      const store = context.openPluginStateKeyedStore<MSTeamsDelegatedTokens>({
        namespace: MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
        maxEntries: MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(store.lookup(MSTEAMS_DELEGATED_TOKEN_KEY)).resolves.toEqual(token);
      expect(await fs.readFile(`${filePath}.migrated`, "utf8")).toBe("old root archive");
      expect(await fs.readFile(`${filePath}.migrated.2`, "utf8")).toBe("old root collision");
      if (archive === "blocked" || archive === "relative-symlink") {
        expect(result.changes).toEqual([
          "Migrated Microsoft Teams delegated OAuth token -> plugin state",
        ]);
        expect(result.warnings).toEqual([
          expect.stringContaining("Failed archiving Microsoft Teams delegated OAuth token"),
        ]);
        expect(await fs.readFile(filePath, "utf8")).toBe(JSON.stringify(token));
        if (archive === "blocked") {
          expect(await fs.readFile(archiveDirectory, "utf8")).toBe("not a directory");
        } else {
          expect(await fs.readlink(filePath)).toBe("tokens.json");
          expect(await fs.readFile(path.join(stateDir, "tokens.json"), "utf8")).toBe(
            JSON.stringify(token),
          );
          await expect(fs.access(archiveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } else {
        expect(result.warnings).toEqual([]);
        expect(result.changes).toEqual([
          "Migrated Microsoft Teams delegated OAuth token -> plugin state",
          expect.stringContaining("Archived Microsoft Teams delegated OAuth token legacy source"),
        ]);
        const archivePath =
          archive === "collision" ? `${archiveBase}.migrated.3` : `${archiveBase}.migrated`;
        expect(await fs.readFile(archivePath, "utf8")).toBe(JSON.stringify(token));
        await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        if (archive === "collision") {
          expect(await fs.readFile(`${archiveBase}.migrated`, "utf8")).toBe("earlier archive");
          expect(await fs.readFile(`${archiveBase}.migrated.2`, "utf8")).toBe(
            "another earlier archive",
          );
        }
      }
    },
  );
});

describe("msteams streaming legacy config rules", () => {
  const rule = legacyConfigRules.find((entry) => entry.message.includes("chunkMode"));

  it("matches flat streaming aliases", () => {
    expect(rule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rule?.match?.({ streamMode: "block" }, {})).toBe(true);
    expect(rule?.match?.({ streaming: { mode: "partial" } }, {})).toBe(false);
  });
});

describe("msteams normalizeCompatibilityConfig streaming aliases", () => {
  function msteamsConfig(entry: Record<string, unknown>) {
    return { channels: { msteams: entry } } as never;
  }

  it("moves flat aliases into the nested streaming shape", () => {
    const result = normalizeCompatibilityConfig({
      cfg: msteamsConfig({
        streamMode: "block",
        chunkMode: "newline",
        blockStreaming: true,
        blockStreamingCoalesce: { idleMs: 250 },
      }),
    });

    const msteams = result.config.channels?.msteams as Record<string, unknown>;
    expect(msteams.streaming).toEqual({
      mode: "block",
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 250 } },
    });
    expect(msteams.streamMode).toBeUndefined();
    expect(msteams.chunkMode).toBeUndefined();
    expect(msteams.blockStreaming).toBeUndefined();
    expect(msteams.blockStreamingCoalesce).toBeUndefined();
    for (const change of [
      "Moved channels.msteams.streamMode → channels.msteams.streaming.mode (block).",
      "Moved channels.msteams.chunkMode → channels.msteams.streaming.chunkMode.",
      "Moved channels.msteams.blockStreaming → channels.msteams.streaming.block.enabled.",
      "Moved channels.msteams.blockStreamingCoalesce → channels.msteams.streaming.block.coalesce.",
    ]) {
      expect(result.changes).toContain(change);
    }
  });

  it("removes a conflicting streamMode when streaming.mode is already set", () => {
    const result = normalizeCompatibilityConfig({
      cfg: msteamsConfig({
        streamMode: "off",
        streaming: { mode: "block" },
      }),
    });

    const msteams = result.config.channels?.msteams as Record<string, unknown>;
    expect(msteams.streamMode).toBeUndefined();
    expect(msteams.streaming).toEqual({ mode: "block" });
    // Doctor drops mutations without change messages, so the conflict removal
    // must be reported or the invalid flat key would never be persisted away.
    expect(result.changes).toEqual([
      "Removed channels.msteams.streamMode (channels.msteams.streaming.mode already set).",
    ]);
  });

  it("removes flat aliases when the nested value is already set", () => {
    const result = normalizeCompatibilityConfig({
      cfg: msteamsConfig({
        blockStreaming: false,
        streaming: { block: { enabled: true } },
      }),
    });

    const msteams = result.config.channels?.msteams as Record<string, unknown>;
    expect(msteams.streaming).toEqual({ block: { enabled: true } });
    expect(msteams.blockStreaming).toBeUndefined();
    expect(result.changes).toContain(
      "Removed channels.msteams.blockStreaming (channels.msteams.streaming.block.enabled already set).",
    );
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: msteamsConfig({ streamMode: "block", chunkMode: "newline" }),
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});
