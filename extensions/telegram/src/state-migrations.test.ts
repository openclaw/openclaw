import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";

const migration = stateMigrations[0]!;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("retired Telegram state", () => {
  let stateDir: string;
  let input: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-telegram-retired-");
    input = {
      config: { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } },
      env: { OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "credentials"),
      context: {
        openPluginStateKeyedStore() {
          throw new Error("retired state inspection must not open canonical stores");
        },
      },
    };
  });

  it("completes inspection when retired sources are absent or already archived", async () => {
    await fs.mkdir(path.join(stateDir, "telegram"));
    await fs.writeFile(path.join(stateDir, "telegram", "update-offset-old.json.migrated"), "old");
    await fs.writeFile(path.join(stateDir, "telegram", "unrelated.json"), "keep");

    expect(await migration.detectLegacyState(input)).toBeNull();
    expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
  });

  it("preserves each retired source and directs pending imports through the bridge release", async () => {
    const storePath = resolveStorePath(undefined, { env: input.env, agentId: "ops" });
    const paths = [
      ...["bot-info-old", "sticker-cache", "thread-bindings-old", "update-offset-old"].map((name) =>
        path.join(stateDir, "telegram", `${name}.json`),
      ),
      `${storePath}.telegram-messages.json`,
      `${storePath}.telegram-sent-messages.json`,
      `${storePath}.telegram-topic-names.json`,
      path.join(stateDir, "sessions", "sessions.json.telegram-messages.json"),
    ];
    for (const source of paths) {
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "unparsed legacy bytes\n");
    }

    const detection = await migration.detectLegacyState(input);
    expect(detection?.preview).toHaveLength(paths.length);
    const result = await migration.migrateLegacyState(input);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(paths.length);
    expect(result.warningDisposition).toBeUndefined();
    for (const source of paths) {
      expect(result.warnings).toContainEqual(
        expect.stringContaining(`${source}. Run openclaw doctor --fix on 2026.9.5`),
      );
      expect(await fs.readFile(source, "utf8")).toBe("unparsed legacy bytes\n");
    }
  });

  it("refuses an unreadable source directory instead of certifying inspection", async () => {
    await fs.writeFile(path.join(stateDir, "telegram"), "not a directory");
    await expect(migration.detectLegacyState(input)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(migration.migrateLegacyState(input)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
