import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readText, readUtf8Text } from "./helpers.js";
import { discoverHermesSource } from "./source.js";
import { hermesCase, item } from "./test/hermes-case.js";
import { configRuntime, useHermesFixture } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture(async (root) => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
});
let h: ReturnType<typeof hermesCase>;
beforeEach(() => {
  h = hermesCase(fixture.paths.root);
});
const read = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
const missing = (file: string) => expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
async function withoutFifoRead(file: string, action: () => Promise<void>) {
  execFileSync("mkfifo", [file]);
  const opened = `${file}.opened`;
  const writer = spawn(
    process.execPath,
    [
      "-e",
      'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "backstop input\\n"); fs.writeFileSync(process.argv[2], "opened"); fs.closeSync(fd);',
      file,
      opened,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) => {
    writer.once("exit", () => resolve());
  });
  try {
    await action();
    // A blocking read cannot finish before the writer records its open and closes.
    await expect(fs.access(opened)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    writer.kill("SIGKILL");
    await exited;
  }
}
async function discover(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") {
  for (const key of [
    "HERMES_HOME",
    "HERMES_S6_SUPERVISED_CHILD",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
  ]) {
    vi.stubEnv(key, env[key]);
  }
  for (const key of ["HOME", "USERPROFILE"]) {
    vi.stubEnv(key, env[key] ?? fixture.paths.root);
  }
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  return (await discoverHermesSource()).root;
}

describe("Hermes files and skills", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "rejects FIFO source reads (required=%s)",
    async (required) => {
      await fs.mkdir(h.source, { recursive: true });
      const file = path.join(h.source, required ? "config.yaml" : "active_profile");
      await withoutFifoRead(file, async () => {
        if (required) {
          const pending = h.plan();
          await expect(pending).rejects.toThrow(/regular file/i);
          await expect(pending).rejects.toThrow(file);
          await expect(pending).rejects.toThrow("retry migration");
        } else {
          await expect(discover({ HERMES_HOME: h.source })).resolves.toBe(h.source);
        }
      });
      expect((await fs.lstat(file)).isFIFO()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("rejects FIFO memory targets", async () => {
    await h.write("memories/MEMORY.md", "Imported memory\n");
    const plan = await h.plan();
    const planned = item(plan, "memory:MEMORY.md");
    if (!planned?.target) {
      throw new Error("expected memory append target");
    }
    await fs.mkdir(h.workspaceDir, { recursive: true });
    await withoutFifoRead(planned.target, async () => {
      const result = await h.apply({ runtime: configRuntime({}) }, plan);
      expect(item(result, "memory:MEMORY.md")?.status).toBe("error");
    });
    expect((await fs.lstat(planned.target)).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps symlinked text inputs and exact Unicode",
    async () => {
      const body = "Café 会议 �\n";
      await h.write("input.txt", body);
      const link = path.join(h.source, "linked-input.txt");
      await fs.symlink(path.join(h.source, "input.txt"), link);
      await expect(readUtf8Text(link)).resolves.toBe(body);
      await expect(readText(link)).resolves.toBe(body);
    },
  );

  it.each(["stat", "readdir"] as const)(
    "rejects incomplete source %s and recovers",
    async (operation) => {
      await h.write("skills/review/SKILL.md", "# Review\n");
      const failure = Object.assign(new Error("source directory unavailable"), { code: "EIO" });
      const spy =
        operation === "stat"
          ? vi.spyOn(fs, "stat").mockRejectedValueOnce(failure)
          : vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
      await expect(h.plan()).rejects.toBe(failure);
      spy.mockRestore();
      expect((await h.plan()).items).toContainEqual(
        expect.objectContaining({ id: "skill:review", kind: "skill", status: "planned" }),
      );
    },
  );

  it("copies nested skills, not support or archived skills", async () => {
    for (const [name, content] of [
      ["coding/review", "Review"],
      ["coding/review/subskills/lint", "Lint"],
      ["coding/review/references/old", "Old"],
      [".archive/retired", "Old"],
    ]) {
      await h.write(`skills/${name}/SKILL.md`, `# ${content}\n`);
    }
    const plan = await h.plan();
    expect(plan.items.filter((entry) => entry.kind === "skill").map((entry) => entry.id)).toEqual([
      "skill:coding:review",
      "skill:coding:review:subskills:lint",
    ]);
    expect((await h.apply({}, plan)).summary.errors).toBe(0);
    expect(await read(h.workspaceDir, "skills/review/SKILL.md")).toBe("# Review\n");
    expect(await read(h.workspaceDir, "skills/lint/SKILL.md")).toBe("# Lint\n");
  });

  it("discovers active profiles and Windows state", async () => {
    const home = path.join(h.root, "home");
    const root = path.join(home, ".hermes");
    const profile = path.join(root, "profiles/coder");
    await writeFile(path.join(root, "active_profile"), "coder\n");
    await writeFile(path.join(profile, "config.yaml"), "model: openai/gpt-5.6\n");
    expect(await discover({ HOME: home })).toBe(profile);
    expect(await discover({ HERMES_HOME: root })).toBe(profile);
    expect(await discover({ HERMES_HOME: profile })).toBe(profile);
    expect(await discover({ HERMES_HOME: root, HERMES_S6_SUPERVISED_CHILD: "1" })).toBe(root);
    expect((await discoverHermesSource(profile)).root).toBe(profile);
    await writeFile(path.join(root, "active_profile"), "../escape\n");
    expect(await discover({ HOME: home })).toBe(root);
    const windowsHome = path.join(h.root, "windows-home");
    const local = path.join(windowsHome, "AppData/Local");
    const native = path.join(local, "hermes");
    const legacy = path.join(windowsHome, ".hermes");
    const env = { LOCALAPPDATA: local, USERPROFILE: windowsHome };
    await writeFile(path.join(legacy, "config.yaml"), "model: legacy\n");
    expect(await discover(env, "win32")).toBe(legacy);
    await writeFile(path.join(native, "config.yaml"), "model: current\n");
    expect(await discover(env, "win32")).toBe(native);
    const persona = path.join(h.root, "persona-home");
    await writeFile(path.join(persona, ".hermes/SOUL.md"), "Legacy persona\n");
    expect(
      await discover(
        { LOCALAPPDATA: path.join(persona, "AppData/Local"), USERPROFILE: persona },
        "win32",
      ),
    ).toBe(path.join(persona, ".hermes"));
  });

  it("maps OAuth providers and reports non-reusable grants", async () => {
    await h.write("config.yaml", "model:\n  provider: xai-oauth\n  default: grok-4.1-fast\n");
    await h.write("auth.json", {
      providers: {
        anthropic: {},
        nous: {},
        "qwen-oauth": {},
        "qwen-cli": {},
        "qwen-portal": {},
        "xai-oauth": {},
        "minimax-oauth": {},
      },
    });
    const plan = await h.plan();
    expect(item(plan, "config:default-model")?.details?.model).toBe("xai/grok-4.1-fast");
    expect(
      plan.items
        .filter(
          (entry) =>
            entry.kind === "manual" && entry.message?.includes("credentials cannot be reused"),
        )
        .map((entry) => entry.reason),
    ).toEqual([
      "Authenticate anthropic in OpenClaw after migration.",
      "Authenticate nous in OpenClaw after migration.",
      "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
      "Authenticate minimax-portal in OpenClaw after migration.",
      "Authenticate xai in OpenClaw after migration.",
    ]);
  });

  it("requests reauthentication for OAuth pools only", async () => {
    await h.write("config.yaml", {});
    await h.write("auth.json", {
      credential_pool: { anthropic: [{ auth_type: "api_key" }], nous: [{ auth_type: "oauth" }] },
    });
    expect(
      (await h.plan()).items
        .filter((entry) => entry.id.startsWith("manual:auth-reauthenticate:"))
        .map((entry) => entry.id),
    ).toEqual(["manual:auth-reauthenticate:nous"]);
  });

  it("rejects normalized skill collisions", async () => {
    await h.write("skills/team-a/review/SKILL.md", "# A\n");
    await h.write("skills/team-b/review/SKILL.md", "# B\n");
    const plan = await h.plan();
    expect(
      plan.items.filter((entry) => entry.kind === "skill").map((entry) => entry.status),
    ).toEqual(["conflict", "conflict"]);
    expect((await h.apply({ overwrite: true, reportDir: h.reportDir })).summary.conflicts).toBe(2);
    await missing(path.join(h.workspaceDir, "skills/review"));
  });

  it("preserves late-created copy targets", async () => {
    await h.write("AGENTS.md", "# Hermes agents\n");
    const ctx = h.context({ reportDir: h.reportDir });
    const plan = await h.provider.plan(ctx);
    await writeFile(path.join(h.workspaceDir, "AGENTS.md"), "# Late agents\n");
    const conflict = await h.plan();
    expect(item(conflict, "workspace:AGENTS.md")?.status).toBe("conflict");
    const result = await h.provider.apply(ctx, plan);
    expect(item(result, "workspace:AGENTS.md")).toMatchObject({
      status: "conflict",
      reason: MIGRATION_REASON_TARGET_EXISTS,
    });
    expect(result.summary.conflicts).toBe(1);
    expect(await read(h.workspaceDir, "AGENTS.md")).toBe("# Late agents\n");
  });

  it("applies files, memories, backups and reports", async () => {
    await h.write("AGENTS.md", "# Hermes agents\n");
    await h.write("memories/MEMORY.md", "memory line\n");
    await h.write("skills/Ship It/SKILL.md", "# Ship It\n");
    await writeFile(path.join(h.workspaceDir, "AGENTS.md"), "# Existing agents\n");
    const result = await h.apply({
      overwrite: true,
      reportDir: h.reportDir,
      runtime: configRuntime({}),
    });
    expect(result.summary).toMatchObject({ errors: 0, conflicts: 0 });
    expect(await read(h.workspaceDir, "AGENTS.md")).toBe("# Hermes agents\n");
    expect(await read(h.workspaceDir, "skills/ship-it/SKILL.md")).toBe("# Ship It\n");
    await fs.access(path.join(h.reportDir, "summary.md"));
    expect(await read(h.workspaceDir, "MEMORY.md")).toContain("Imported from Hermes");
    expect(String(item(result, "workspace:AGENTS.md")?.details?.backupPath)).toContain("AGENTS.md");
  });

  it.each(["MEMORY.md", "USER.md"])(
    "rejects malformed UTF-8 in %s without appending",
    async (name) => {
      const source = path.join(h.source, "memories", name);
      const target = path.join(h.workspaceDir, name);
      const bytes = Buffer.from([0x61, 0xc3, 0x28, 0x0a]);
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, bytes);
      await writeFile(target, "existing memory\n");
      const result = await h.apply({ runtime: configRuntime({}) });
      expect(item(result, `memory:${name}`)).toMatchObject({
        status: "error",
        reason: expect.stringContaining("UTF-8"),
      });
      expect(await read(target)).toBe("existing memory\n");
      expect(await fs.readFile(source)).toEqual(bytes);
    },
  );

  it("keeps repeated memory imports byte-identical", async () => {
    const memory = "\uFEFFone memory 中文 🦞 and literal \uFFFD\n";
    await h.write("memories/MEMORY.md", memory);
    const ctx = h.context({ overwrite: true, runtime: configRuntime({}) });
    await h.provider.apply(ctx);
    const first = await read(h.workspaceDir, "MEMORY.md");
    expect(first).toBe(`\n\n<!-- Imported from Hermes: MEMORY.md -->\n\n${memory}`);
    const again = await h.provider.apply(ctx);
    expect(await read(h.workspaceDir, "MEMORY.md")).toBe(first);
    expect(item(again, "memory:MEMORY.md")?.status).toBe("skipped");
  });

  it("reports malformed YAML with its original cause", async () => {
    await h.write("config.yaml", "model: [unterminated\n");
    const planning = h.plan({ workspaceDir: path.join(h.root, "ws") });
    await expect(planning).rejects.toThrow(
      `Failed to parse Hermes config at ${path.join(h.source, "config.yaml")}`,
    );
    await expect(planning).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "YAMLParseError" }),
    });
  });

  it("archives unsupported state, never raw auth", async () => {
    const files = {
      "logs/session.log": "log line\n",
      "pairing/approved.json": '{"approved":[]}\n',
      "platforms/pairing/telegram.json": "{}\n",
      "gateway_state.json": '{"running":false}\n',
      "auth.json": '{"token":"opaque"}\n',
    };
    for (const [file, data] of Object.entries(files)) {
      await h.write(file, data);
    }
    new DatabaseSync(path.join(h.source, "retaindb_queue.db")).close();
    expect(await h.provider.detect?.(h.context())).toMatchObject({
      found: true,
      source: h.source,
      confidence: "high",
    });
    const plan = await h.plan({ reportDir: h.reportDir });
    expect(item(plan, "archive:auth.json")).toBeUndefined();
    const result = await h.apply({ reportDir: h.reportDir }, plan);
    expect(result.summary.errors).toBe(0);
    expect(item(result, "archive:logs")).toMatchObject({
      status: "migrated",
      target: path.join(h.reportDir, "archive/logs"),
    });
    for (const [name, bytes] of Object.entries(files)) {
      if (name !== "auth.json") {
        expect(await read(h.reportDir, "archive", name)).toBe(bytes);
      }
    }
    await fs.access(path.join(h.reportDir, "archive/retaindb_queue.db"));
    await missing(path.join(h.reportDir, "archive/auth.json"));
    await missing(path.join(h.workspaceDir, "logs/session.log"));
  });

  it("archives committed SQLite WAL state", async () => {
    const source = path.join(h.source, "hermes_state.db");
    await fs.mkdir(h.source, { recursive: true });
    const db = new DatabaseSync(source);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE marker(value TEXT NOT NULL);
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      db.prepare("INSERT INTO marker(value) VALUES (?)").run("committed-only-in-wal");
      expect((await fs.stat(`${source}-wal`)).size).toBeGreaterThan(0);
      const result = await h.apply({ reportDir: h.reportDir });
      const target = path.join(h.reportDir, "archive/hermes_state.db");
      expect(item(result, "archive:hermes_state.db")?.status).toBe("migrated");
      const archive = new DatabaseSync(target, { readOnly: true });
      try {
        expect(archive.prepare("SELECT value FROM marker").all()).toEqual([
          { value: "committed-only-in-wal" },
        ]);
        expect(archive.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        archive.close();
      }
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "preserves raw SQLite recovery files (vanishing WAL=%s)",
    async (vanish) => {
      const source = path.join(h.source, "state.db");
      const wal = `${source}-wal`;
      await h.write("state.db", "legacy non-SQLite Hermes state\n");
      if (vanish) {
        await writeFile(wal, "transient wal\n");
        const copy = fs.copyFile.bind(fs);
        vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
          if (from === wal) {
            await fs.rm(wal, { force: true });
            throw Object.assign(new Error("sidecar vanished"), { code: "ENOENT" });
          }
          return await copy(from, to, mode);
        });
      }
      const result = await h.apply({ reportDir: h.reportDir });
      const target = path.join(h.reportDir, "archive/state.db");
      expect(item(result, "archive:state.db")).toMatchObject({
        status: "error",
        target,
        reason: expect.stringContaining(
          "SQLite snapshot failed; database recovery files preserved for manual review",
        ),
      });
      expect(await read(target, "state.db")).toBe("legacy non-SQLite Hermes state\n");
      expect(result.summary.errors).toBe(1);
    },
  );
});
