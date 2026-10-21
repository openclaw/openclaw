import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec-run.js";

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: async () => ({ allowWithoutEnforcedCommand: true }),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by live state SQLite guard tests");
  },
}));

vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const describeNonWin = process.platform === "win32" ? describe.skip : describe;
const quote = (value: string) => JSON.stringify(value);

async function databaseFixture(root: string, relativePath: string) {
  const databasePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.writeFile(databasePath, "fixture");
  return databasePath;
}

function guard(context: { stateDir: string; workdir: string }) {
  return async (commands: string[], expected: "live-state-sqlite" | null = "live-state-sqlite") => {
    for (const command of commands) {
      await expect(detectUnsafeExecControlShellCommand(command, context)).resolves.toBe(expected);
    }
  };
}

async function withSpawnFixture(
  relativePath: string,
  run: (fixture: {
    root: string;
    databasePath: string;
    sqlitePath: string;
    markerPath: string;
    tool: ReturnType<typeof createExecTool>;
  }) => Promise<void>,
) {
  await withTempDir("openclaw-exec-live-sqlite-spawn-", async (root) => {
    const stateDir = path.join(root, "state");
    // Leave live paths empty: fake database contents would poison the tool's own state access.
    const databasePath = path.join(stateDir, relativePath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const sqlitePath = path.join(root, "sqlite3");
    const markerPath = path.join(root, "sqlite-spawned");
    await fs.writeFile(sqlitePath, `#!/bin/sh\nprintf spawned > ${quote(markerPath)}\n`, {
      mode: 0o755,
    });
    await withEnvAsync(
      { HOME: root, USERPROFILE: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir },
      () =>
        run({
          root,
          databasePath,
          sqlitePath,
          markerPath,
          tool: createExecTool({
            host: "gateway",
            security: "full",
            ask: "on-miss",
            allowBackground: false,
          }),
        }),
    );
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describeNonWin("exec live OpenClaw state SQLite guard", () => {
  it("detects direct and carrier-wrapped SQLite targets under the active state directory", async () => {
    await withTempDir("openclaw-exec-live-sqlite-", async (root) => {
      const stateDir = path.join(root, "state with spaces");
      const databasePath = await databaseFixture(stateDir, "state/openclaw.sqlite");
      await guard({ stateDir, workdir: root })([
        `sqlite3 --json ${quote(databasePath)}`,
        `sudo -u openclaw env sqlite3 -header -column ${quote(databasePath)}`,
        'sqlite3 -cmd ".timeout 1000" "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"',
        `sqlite3 :memory: ${quote(`.open ${quote(databasePath)}`)}`,
        `sqlite3 :memory: ${quote(`.op ${quote(databasePath)}`)}`,
        `sqlite3 -cmd ${quote(`.open --readonly ${quote(databasePath)}`)} :memory:`,
      ]);
    });
  });

  it("detects relative and symlink-aliased live state targets", async () => {
    await withTempDir("openclaw-exec-live-sqlite-alias-", async (root) => {
      const stateDir = path.join(root, "state");
      const aliasDir = path.join(root, "state-alias");
      await databaseFixture(stateDir, "agents/main/state.sqlite");
      await fs.symlink(stateDir, aliasDir);
      await guard({ stateDir, workdir: root })([
        "sqlite3 state/agents/main/state.sqlite",
        `sqlite3 --readonly ${quote(path.join(aliasDir, "agents", "main", "state.sqlite"))}`,
      ]);
    });
  });

  it("detects live state targets hidden behind file: URI variable spellings", async () => {
    await withTempDir("openclaw-exec-live-sqlite-uri-", async (root) => {
      const stateDir = path.join(root, "state with spaces");
      const databasePath = await databaseFixture(stateDir, "state/openclaw.sqlite");
      const check = guard({ stateDir, workdir: root });
      await check([
        'sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "file:${OPENCLAW_STATE_DIR}/state/openclaw.sqlite" "PRAGMA user_version"',
        `sqlite3 -cmd ${quote(`.open ${quote("file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite")}`)} :memory:`,
        `sqlite3 "file:${databasePath}?mode=ro"`,
        // Empty and localhost authorities also expand to a valid absolute file URI.
        'sqlite3 "file://$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "file://${OPENCLAW_STATE_DIR}/state/openclaw.sqlite" "PRAGMA user_version"',
        'sqlite3 "file://localhost$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "PRAGMA user_version"',
        'sqlite3 "FILE://$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "PRAGMA user_version"',
      ]);
      const copy = await databaseFixture(root, "snapshot/openclaw.sqlite");
      await check([`sqlite3 "file:${copy}?mode=ro"`, `sqlite3 "file://${copy}?mode=ro"`], null);
    });
  });

  it("detects file: URI targets spelled with $HOME when state lives under HOME", async () => {
    await withTempDir("openclaw-exec-live-sqlite-home-", async (root) => {
      const stateDir = path.join(root, "home", ".openclaw");
      await databaseFixture(stateDir, "state/openclaw.sqlite");
      // The guard reads os.homedir(), not process.env.HOME.
      vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
      const check = guard({ stateDir, workdir: root });
      await check([
        'sqlite3 "file:$HOME/.openclaw/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "$HOME/.openclaw/state/openclaw.sqlite" "PRAGMA user_version"',
      ]);
      await check(['sqlite3 "file:$HOME/snapshots/openclaw.sqlite?mode=ro"'], null);
      const inside = guard({ stateDir, workdir: path.join(stateDir, "workspace") });
      // Relative file URIs are root-relative, not relative to the exec workdir.
      await inside([`cd ${quote(root)} && sqlite3 "file:data/app.db?mode=ro" "SELECT 1"`], null);
      await inside([
        `cd ${quote(root)} && sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro"`,
      ]);
    });
  });

  it("allows SQLite inspection of a private copy outside the active state directory", async () => {
    await withTempDir("openclaw-exec-copied-sqlite-", async (root) => {
      const stateDir = path.join(root, "state");
      const copy = await databaseFixture(root, "snapshot/openclaw.sqlite");
      await guard({ stateDir, workdir: root })(
        [
          `sqlite3 ${quote(copy)}`,
          `sqlite3 :memory: ${quote(`.open ${quote(copy)}`)}`,
          `sqlite3 -cmd ${quote(`.open --readonly ${quote(copy)}`)} :memory:`,
          `cat ${quote(path.join(stateDir, "state.sqlite"))}`,
        ],
        null,
      );
    });
  });

  it("rejects the live target before the external SQLite process starts", async () => {
    await withSpawnFixture(
      "agents/main/state.sqlite",
      async ({ root, databasePath, sqlitePath, markerPath, tool }) => {
        await expect(
          tool.execute("call-live-sqlite", {
            command: `${quote(sqlitePath)} :memory: ${quote(`.open ${quote(databasePath)}`)}`,
            workdir: root,
          }),
        ).rejects.toThrow(
          /external sqlite3 cannot open databases under the active OpenClaw state directory/,
        );
        await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("rejects a variable-bearing file: URI live target before spawn and runs a private-copy URI", async () => {
    await withSpawnFixture(
      "state/openclaw.sqlite",
      async ({ root, sqlitePath, markerPath, tool }) => {
        await expect(
          tool.execute("call-live-sqlite-uri", {
            command: `${quote(sqlitePath)} "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"`,
            workdir: root,
          }),
        ).rejects.toThrow(
          /external sqlite3 cannot open databases under the active OpenClaw state directory/,
        );
        await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        const copy = await databaseFixture(root, "snapshot/openclaw.sqlite");
        const privateMarkerPath = path.join(root, "private-spawned");
        await fs.writeFile(
          sqlitePath,
          `#!/bin/sh\nprintf spawned > ${quote(privateMarkerPath)}\n`,
          {
            mode: 0o755,
          },
        );
        await tool.execute("call-private-sqlite-uri", {
          command: `${quote(sqlitePath)} "file:${copy}?mode=ro" "PRAGMA user_version"`,
          workdir: root,
        });
        await expect(fs.stat(privateMarkerPath)).resolves.toBeDefined();
      },
    );
  });
});
