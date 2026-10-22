import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import { MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import { resolvePlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { buildAuthItems } from "./auth.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { discoverHermesSource } from "./source.js";
import { fakeJwt } from "./test/auth-helpers.js";
import { configRuntime, useHermesFixture, writeJson } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const provider = buildHermesMigrationProvider();

const fixture = useHermesFixture(async (root) => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
});
const makeTestContext = fixture.context;

function discoverSource(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") {
  vi.stubEnv("HERMES_HOME", env.HERMES_HOME);
  vi.stubEnv("HERMES_S6_SUPERVISED_CHILD", env.HERMES_S6_SUPERVISED_CHILD);
  vi.stubEnv("LOCALAPPDATA", env.LOCALAPPDATA);
  vi.stubEnv("XDG_DATA_HOME", env.XDG_DATA_HOME);
  vi.stubEnv("HOME", env.HOME ?? fixture.paths.root);
  vi.stubEnv("USERPROFILE", env.USERPROFILE ?? fixture.paths.root);
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  return discoverHermesSource();
}

async function discoverRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") {
  return (await discoverSource(env, platform)).root;
}

function readText(...parts: string[]) {
  return fs.readFile(path.join(...parts), "utf8");
}

describe("Hermes migration file and skill items", () => {
  function itemById<T extends { id: string }>(items: T[], id: string): T | undefined {
    return items.find((item) => item.id === id);
  }

  const hermesAccessField = ["access", "token"].join("_");
  const hermesRefreshField = ["refresh", "token"].join("_");

  it.each(["stat", "readdir"] as const)(
    "rejects an incomplete plan when source directory %s fails",
    async (operation) => {
      const { source, workspaceDir } = fixture.paths;
      await writeFile(path.join(source, "skills", "review", "SKILL.md"), "# Review\n");
      const failure = Object.assign(new Error("source directory unavailable"), { code: "EIO" });
      const read =
        operation === "stat"
          ? vi.spyOn(fs, "stat").mockRejectedValueOnce(failure)
          : vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
      const ctx = makeTestContext({ workspaceDir });

      await expect(provider.plan(ctx)).rejects.toBe(failure);

      read.mockRestore();
      const recovered = await provider.plan(ctx);
      expect(recovered.items).toContainEqual(
        expect.objectContaining({ id: "skill:review", kind: "skill", status: "planned" }),
      );
    },
  );

  it("discovers nested skills while pruning inactive packages", async () => {
    const { source, workspaceDir } = fixture.paths;
    await writeFile(path.join(source, "skills", "coding", "review", "SKILL.md"), "# Review\n");
    await writeFile(
      path.join(source, "skills", "coding", "review", "subskills", "lint", "SKILL.md"),
      "# Lint\n",
    );
    await writeFile(
      path.join(source, "skills", "coding", "review", "references", "old", "SKILL.md"),
      "# Old\n",
    );
    await writeFile(path.join(source, "skills", ".archive", "retired", "SKILL.md"), "# Old\n");

    const plan = await provider.plan(makeTestContext({ workspaceDir }));
    const skills = plan.items.filter((item) => item.kind === "skill");
    expect(skills).toHaveLength(2);
    expect(itemById(skills, "skill:coding:review")).toMatchObject({
      id: "skill:coding:review",
      source: path.join(source, "skills", "coding", "review"),
      target: path.join(workspaceDir, "skills", "review"),
    });
    expect(itemById(skills, "skill:coding:review:subskills:lint")).toMatchObject({
      source: path.join(source, "skills", "coding", "review", "subskills", "lint"),
      target: path.join(workspaceDir, "skills", "lint"),
    });
  });

  it("resolves HERMES_HOME through active_profile unless it already names a profile", async () => {
    const root = fixture.paths.root;
    const hermesRoot = path.join(root, "hermes");
    const profileRoot = path.join(hermesRoot, "profiles", "coder");
    await writeFile(path.join(hermesRoot, "active_profile"), "coder\n");
    await writeFile(path.join(profileRoot, "memories", "MEMORY.md"), "coder memory\n");

    expect(await discoverRoot({ HERMES_HOME: hermesRoot })).toBe(profileRoot);
    expect(await discoverRoot({ HERMES_HOME: profileRoot })).toBe(profileRoot);
    // Supervised default slot pins to the root profile, ignoring active_profile.
    expect(await discoverRoot({ HERMES_HOME: hermesRoot, HERMES_S6_SUPERVISED_CHILD: "1" })).toBe(
      hermesRoot,
    );
  });

  it("honors implicit Hermes active profiles and Windows legacy state", async () => {
    const root = fixture.paths.root;
    const home = path.join(root, "home");
    const defaultRoot = path.join(home, ".hermes");
    const profileRoot = path.join(defaultRoot, "profiles", "coder");
    await writeFile(path.join(defaultRoot, "active_profile"), "coder\n");
    await writeFile(path.join(profileRoot, "config.yaml"), "model: openai/gpt-5.6\n");

    expect(await discoverRoot({ HOME: home })).toBe(profileRoot);
    expect((await discoverHermesSource(profileRoot)).root).toBe(profileRoot);

    await writeFile(path.join(defaultRoot, "active_profile"), "../escape\n");
    expect(await discoverRoot({ HOME: home })).toBe(defaultRoot);

    const windowsHome = path.join(root, "windows-home");
    const localAppData = path.join(windowsHome, "AppData", "Local");
    const nativeWindowsRoot = path.join(localAppData, "hermes");
    const legacyWindowsRoot = path.join(windowsHome, ".hermes");
    await writeFile(path.join(legacyWindowsRoot, "config.yaml"), "model: legacy\n");
    expect(
      await discoverRoot({ LOCALAPPDATA: localAppData, USERPROFILE: windowsHome }, "win32"),
    ).toBe(legacyWindowsRoot);
    await writeFile(path.join(nativeWindowsRoot, "config.yaml"), "model: current\n");
    expect(
      await discoverRoot({ LOCALAPPDATA: localAppData, USERPROFILE: windowsHome }, "win32"),
    ).toBe(nativeWindowsRoot);

    const personaHome = path.join(root, "persona-home");
    const personaLocalAppData = path.join(personaHome, "AppData", "Local");
    const personaLegacyRoot = path.join(personaHome, ".hermes");
    await writeFile(path.join(personaLegacyRoot, "SOUL.md"), "Legacy persona\n");
    expect(
      await discoverRoot({ LOCALAPPDATA: personaLocalAppData, USERPROFILE: personaHome }, "win32"),
    ).toBe(personaLegacyRoot);
  });

  it("uses global Hermes auth per provider when the active profile has no local entry", async () => {
    const root = fixture.paths.root;
    const home = path.join(root, "home");
    const hermesRoot = path.join(home, ".hermes");
    const profileRoot = path.join(hermesRoot, "profiles", "coder");

    const access = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-global" },
      "https://api.openai.com/profile": { email: "global@example.test" },
    });
    await writeFile(path.join(hermesRoot, "active_profile"), "coder\n");
    await writeFile(path.join(profileRoot, "config.yaml"), "model: openai/gpt-5.6\n");
    await writeJson(path.join(profileRoot, "auth.json"), { providers: {} });
    await writeJson(path.join(hermesRoot, "auth.json"), {
      providers: {
        "openai-codex": {
          tokens: { [hermesAccessField]: access, [hermesRefreshField]: "global-refresh" },
        },
      },
    });

    const source = await discoverSource({ HOME: home });
    expect(source.root).toBe(profileRoot);
    expect(source.globalAuthPath).toBe(path.join(hermesRoot, "auth.json"));
    const ctx = makeTestContext({ source: profileRoot, includeSecrets: true });
    const items = await buildAuthItems({
      ctx,
      source,
      targets: resolvePlannedMigrationTargets(ctx),
    });
    expect(items).toEqual([
      expect.objectContaining({
        source: path.join(hermesRoot, "auth.json"),
        details: expect.objectContaining({ provider: "openai" }),
      }),
    ]);
  });

  it("maps supported OAuth model providers and requests fresh OpenClaw authentication", async () => {
    const { source } = fixture.paths;
    const xaiProvider = ["xai", "oauth"].join("-");
    const minimaxProvider = ["minimax", "oauth"].join("-");
    await writeFile(
      path.join(source, "config.yaml"),
      `model:\n  provider: ${xaiProvider}\n  default: grok-4.1-fast\n`,
    );
    await writeJson(path.join(source, "auth.json"), {
      providers: {
        anthropic: {},
        nous: {},
        "qwen-oauth": {},
        "qwen-cli": {},
        "qwen-portal": {},
        [xaiProvider]: {},
        [minimaxProvider]: {},
      },
    });

    const plan = await provider.plan(makeTestContext());

    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("xai/grok-4.1-fast");
    const reauthItems = plan.items.filter(
      (item) => item.kind === "manual" && item.message?.includes("credentials cannot be reused"),
    );
    expect(reauthItems.map((item) => item.reason)).toEqual([
      "Authenticate anthropic in OpenClaw after migration.",
      "Authenticate nous in OpenClaw after migration.",
      "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
      "Authenticate minimax-portal in OpenClaw after migration.",
      "Authenticate xai in OpenClaw after migration.",
    ]);
  });

  it("requests reauthentication only for OAuth credential-pool entries", async () => {
    const { source } = fixture.paths;
    await writeFile(path.join(source, "config.yaml"), "{}\n");
    await writeJson(path.join(source, "auth.json"), {
      credential_pool: { anthropic: [{ auth_type: "api_key" }], nous: [{ auth_type: "oauth" }] },
    });

    const plan = await provider.plan(makeTestContext());

    expect(
      plan.items
        .filter((item) => item.id.startsWith("manual:auth-reauthenticate:"))
        .map((item) => item.id),
    ).toEqual(["manual:auth-reauthenticate:nous"]);
  });

  async function expectPathMissing(targetPath: string): Promise<void> {
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  }

  it("reports normalized skill-name collisions instead of overwriting during apply", async () => {
    const { root, source, workspaceDir } = fixture.paths;
    await writeFile(path.join(source, "skills", "team-a", "review", "SKILL.md"), "# A\n");
    await writeFile(path.join(source, "skills", "team-b", "review", "SKILL.md"), "# B\n");

    const plan = await provider.plan(makeTestContext({ workspaceDir }));
    const skillItems = plan.items.filter((item) => item.kind === "skill");

    expect(skillItems).toHaveLength(2);
    const reviewA = itemById(skillItems, "skill:team-a:review");
    const reviewB = itemById(skillItems, "skill:team-b:review");
    expect(reviewA?.status).toBe("conflict");
    expect(reviewA?.reason).toBe('multiple Hermes skill directories normalize to "review"');
    expect(reviewA?.target).toBe(path.join(workspaceDir, "skills", "review"));
    expect(reviewB?.status).toBe("conflict");

    const result = await provider.apply(
      makeTestContext({ overwrite: true, reportDir: path.join(root, "report") }),
    );

    expect(result.summary.conflicts).toBe(2);
    await expectPathMissing(path.join(workspaceDir, "skills", "review"));
  });

  it("reports late-created copy targets as conflicts without overwriting", async () => {
    const { source, workspaceDir, reportDir } = fixture.paths;
    await writeFile(path.join(source, "AGENTS.md"), "# Hermes agents\n");

    const ctx = makeTestContext({ reportDir });
    const plan = await provider.plan(ctx);
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Late agents\n");

    const result = await provider.apply(ctx, plan);

    const agents = itemById(result.items, "workspace:AGENTS.md");
    expect(agents?.status).toBe("conflict");
    expect(agents?.reason).toBe(MIGRATION_REASON_TARGET_EXISTS);
    expect(result.summary.conflicts).toBe(1);
    expect(await readText(workspaceDir, "AGENTS.md")).toBe("# Late agents\n");
  });

  it("applies files, appended memories, item backups, reports, and opt-in API keys", async () => {
    const { source, workspaceDir, stateDir, reportDir } = fixture.paths;
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(path.join(source, "AGENTS.md"), "# Hermes agents\n");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "memory line\n");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Existing agents\n");

    const config: Record<string, unknown> = {};
    const result = await provider.apply(
      makeTestContext({
        includeSecrets: true,
        overwrite: true,
        reportDir,
        runtime: configRuntime(config),
      }),
    );

    expect(result.summary).toMatchObject({ errors: 0, conflicts: 0 });
    expect(await readText(workspaceDir, "AGENTS.md")).toBe("# Hermes agents\n");
    expect(await readText(workspaceDir, "skills", "ship-it", "SKILL.md")).toBe("# Ship It\n");
    await fs.access(path.join(reportDir, "summary.md"));
    expect(await readText(workspaceDir, "MEMORY.md")).toContain("Imported from Hermes");
    const copiedAgentsItem = result.items.find((item) => item.id === "workspace:AGENTS.md");
    expect(String(copiedAgentsItem?.details?.backupPath)).toContain("AGENTS.md");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    const authStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
    });
  });

  it.each(["MEMORY.md", "USER.md"])(
    "refuses malformed UTF-8 in %s without appending",
    async (filename) => {
      const { source, workspaceDir } = fixture.paths;
      const sourcePath = path.join(source, "memories", filename);
      const targetPath = path.join(workspaceDir, filename);
      const invalid = Buffer.from([0x61, 0xc3, 0x28, 0x0a]);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, invalid);
      await writeFile(targetPath, "existing memory\n");

      const result = await provider.apply(makeTestContext({ runtime: configRuntime({}) }));

      expect(itemById(result.items, `memory:${filename}`)).toMatchObject({
        status: "error",
        reason: expect.stringContaining("UTF-8"),
      });
      expect(await fs.readFile(targetPath, "utf8")).toBe("existing memory\n");
      expect(await fs.readFile(sourcePath)).toEqual(invalid);
    },
  );

  it("keeps repeated memory imports byte-identical", async () => {
    const { source, workspaceDir } = fixture.paths;
    const memory = "\uFEFFone memory 中文 🦞 and literal \uFFFD\n";
    await writeFile(path.join(source, "memories", "MEMORY.md"), memory);
    const ctx = makeTestContext({ overwrite: true, runtime: configRuntime({}) });
    await provider.apply(ctx);
    const first = await readText(workspaceDir, "MEMORY.md");
    expect(first).toBe(`\n\n<!-- Imported from Hermes: MEMORY.md -->\n\n${memory}`);
    const secondResult = await provider.apply(ctx);
    expect(await readText(workspaceDir, "MEMORY.md")).toBe(first);
    expect(itemById(secondResult.items, "memory:MEMORY.md")?.status).toBe("skipped");
  });

  it("plans nested mapping config alongside independent skills", async () => {
    const { source, workspaceDir } = fixture.paths;
    await writeFile(path.join(source, "skills", "review", "SKILL.md"), "# Review\n");
    await writeFile(
      path.join(source, "config.yaml"),
      "skills:\n  disabled: [review]\n  config:\n    review:\n      mode: careful\n",
    );

    const plan = await provider.plan(makeTestContext({ workspaceDir }));

    expect(plan.items).toEqual([
      expect.objectContaining({
        id: "config:skill-entry:review",
        kind: "config",
        status: "planned",
        details: {
          path: ["skills", "entries", "review"],
          value: { config: { mode: "careful" }, enabled: false },
        },
      }),
      expect.objectContaining({
        id: "skill:review",
        kind: "skill",
        action: "copy",
        status: "planned",
        details: { skillName: "review" },
      }),
    ]);
  });

  it("fails planning on malformed Hermes YAML", async () => {
    const { root, source } = fixture.paths;
    await writeFile(path.join(source, "config.yaml"), "model: [unterminated\n");
    const planning = provider.plan(makeTestContext({ workspaceDir: path.join(root, "ws") }));
    await expect(planning).rejects.toThrow(
      `Failed to parse Hermes config at ${path.join(source, "config.yaml")}`,
    );
    await expect(planning).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "YAMLParseError" }),
    });
  });

  it("archives unsupported Hermes state without copying raw auth credentials", async () => {
    const { source, workspaceDir, reportDir } = fixture.paths;
    await writeFile(path.join(source, "logs", "session.log"), "log line\n");
    await writeFile(path.join(source, "pairing", "approved.json"), '{"approved":[]}\n');
    await writeFile(path.join(source, "platforms", "pairing", "telegram.json"), "{}\n");
    await writeFile(path.join(source, "gateway_state.json"), '{"running":false}\n');
    await writeFile(path.join(source, "channel_directory.json"), "{}\n");
    await writeFile(path.join(source, "channel_aliases.json"), "{}\n");
    await writeFile(path.join(source, "processes.json"), "{}\n");
    await writeFile(path.join(source, "feishu_comment_pairing.json"), "{}\n");
    await writeFile(path.join(source, "auth.json"), '{"token":"opaque"}\n');
    new DatabaseSync(path.join(source, "retaindb_queue.db")).close();

    const plan = await provider.plan(makeTestContext({ reportDir }));

    const plannedLogs = itemById(plan.items, "archive:logs");
    expect(plannedLogs).toMatchObject({ kind: "archive", action: "archive", status: "planned" });
    for (const itemId of [
      "archive:pairing",
      "archive:platforms",
      "archive:gateway_state.json",
      "archive:channel_directory.json",
      "archive:channel_aliases.json",
      "archive:processes.json",
      "archive:feishu_comment_pairing.json",
      "archive:retaindb_queue.db",
    ]) {
      expect(itemById(plan.items, itemId)?.status).toBe("planned");
    }
    expect(plan.items.find((item) => item.id === "archive:auth.json")).toBeUndefined();
    expect(plan.warnings).toEqual([
      "Some Hermes files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw.",
    ]);

    const result = await provider.apply(makeTestContext({ reportDir }));

    expect(result.summary.errors).toBe(0);
    const migratedLogs = itemById(result.items, "archive:logs");
    expect(migratedLogs?.status).toBe("migrated");
    expect(migratedLogs?.target).toBe(path.join(reportDir, "archive", "logs"));
    expect(await readText(reportDir, "archive", "logs", "session.log")).toBe("log line\n");
    expect(await readText(reportDir, "archive", "pairing", "approved.json")).toBe(
      '{"approved":[]}\n',
    );
    expect(await readText(reportDir, "archive", "platforms", "pairing", "telegram.json")).toBe(
      "{}\n",
    );
    await fs.access(path.join(reportDir, "archive", "retaindb_queue.db"));
    await expectPathMissing(path.join(reportDir, "archive", "auth.json"));
    await expectPathMissing(path.join(workspaceDir, "logs", "session.log"));
  });

  it("archives committed Hermes SQLite WAL state", async () => {
    const { source, reportDir } = fixture.paths;
    const stateDbPath = path.join(source, "hermes_state.db");
    await fs.mkdir(source, { recursive: true });

    const sourceDb = new DatabaseSync(stateDbPath);
    try {
      sourceDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE marker(value TEXT NOT NULL);
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      sourceDb.prepare("INSERT INTO marker(value) VALUES (?)").run("committed-only-in-wal");
      expect((await fs.stat(`${stateDbPath}-wal`)).size).toBeGreaterThan(0);

      const result = await provider.apply(makeTestContext({ reportDir }));

      const archivedState = itemById(result.items, "archive:hermes_state.db");
      const archivedStatePath = path.join(reportDir, "archive", "hermes_state.db");
      expect(archivedState?.status).toBe("migrated");
      expect(archivedState?.source).toBe(stateDbPath);
      expect(archivedState?.target).toBe(archivedStatePath);

      const archivedDb = new DatabaseSync(archivedStatePath, { readOnly: true });
      try {
        expect(archivedDb.prepare("SELECT value FROM marker").all()).toEqual([
          { value: "committed-only-in-wal" },
        ]);
        expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        archivedDb.close();
      }
    } finally {
      sourceDb.close();
    }
  });

  it("preserves raw Hermes state when SQLite snapshotting fails", async () => {
    const { source, reportDir } = fixture.paths;
    const stateDbPath = path.join(source, "state.db");
    const archivedStatePath = path.join(reportDir, "archive", "state.db");
    await writeFile(stateDbPath, "legacy non-SQLite Hermes state\n");

    const result = await provider.apply(makeTestContext({ reportDir }));

    const archivedState = itemById(result.items, "archive:state.db");
    expect(archivedState?.status).toBe("error");
    expect(archivedState?.target).toBe(archivedStatePath);
    expect(archivedState?.reason).toContain(
      "SQLite snapshot failed; database recovery files preserved for manual review",
    );
    expect(await readText(archivedStatePath, "state.db")).toBe("legacy non-SQLite Hermes state\n");
    expect(result.summary.errors).toBe(1);
  });

  it("tolerates a disappearing optional SQLite recovery sidecar", async () => {
    const { root, source } = fixture.paths;
    const stateDbPath = path.join(source, "state.db");
    const walPath = `${stateDbPath}-wal`;
    const reportDir = path.join(root, "report");
    await writeFile(stateDbPath, "legacy non-SQLite Hermes state\n");
    await writeFile(walPath, "transient wal\n");
    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (sourcePath, targetPath, mode) => {
      if (sourcePath === walPath) {
        await fs.rm(walPath, { force: true });
        throw Object.assign(new Error("sidecar vanished"), { code: "ENOENT" });
      }
      return await copyFile(sourcePath, targetPath, mode);
    });

    const result = await provider.apply(makeTestContext({ reportDir }));

    const archivedState = itemById(result.items, "archive:state.db");
    expect(archivedState?.status).toBe("error");
    expect(archivedState?.reason).toContain("recovery files preserved");
    expect(await readText(reportDir, "archive", "state.db", "state.db")).toBe(
      "legacy non-SQLite Hermes state\n",
    );
  });
});
