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

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describeNonWin("exec live OpenClaw state SQLite guard", () => {
  it("detects direct and carrier-wrapped SQLite targets under the active state directory", async () => {
    await withTempDir("openclaw-exec-live-sqlite-", async (root) => {
      const stateDir = path.join(root, "state with spaces");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "fixture");

      const context = { stateDir, workdir: root };
      await expect(
        detectUnsafeExecControlShellCommand(`sqlite3 --json ${quote(databasePath)}`, context),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sudo -u openclaw env sqlite3 -header -column ${quote(databasePath)}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 -cmd ".timeout 1000" "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"',
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 :memory: ${quote(`.open ${quote(databasePath)}`)}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 :memory: ${quote(`.op ${quote(databasePath)}`)}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 -cmd ${quote(`.open --readonly ${quote(databasePath)}`)} :memory:`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
    });
  });

  it("detects relative and symlink-aliased live state targets", async () => {
    await withTempDir("openclaw-exec-live-sqlite-alias-", async (root) => {
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "agents", "main", "state.sqlite");
      const aliasDir = path.join(root, "state-alias");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "fixture");
      await fs.symlink(stateDir, aliasDir);

      const context = { stateDir, workdir: root };
      await expect(
        detectUnsafeExecControlShellCommand("sqlite3 state/agents/main/state.sqlite", context),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 --readonly ${quote(path.join(aliasDir, "agents", "main", "state.sqlite"))}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
    });
  });

  it("detects live state targets hidden behind file: URI variable spellings", async () => {
    await withTempDir("openclaw-exec-live-sqlite-uri-", async (root) => {
      const stateDir = path.join(root, "state with spaces");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "fixture");

      const context = { stateDir, workdir: root };
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 "file:${OPENCLAW_STATE_DIR}/state/openclaw.sqlite" "PRAGMA user_version"',
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 -cmd ${quote(`.open ${quote("file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite")}`)} :memory:`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(`sqlite3 "file:${databasePath}?mode=ro"`, context),
      ).resolves.toBe("live-state-sqlite");

      // The shell expands "file://$VAR/…" to the valid URI "file:///<state>/…",
      // so empty and localhost authorities in front of the variable are refused too.
      for (const command of [
        'sqlite3 "file://$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "file://${OPENCLAW_STATE_DIR}/state/openclaw.sqlite" "PRAGMA user_version"',
        'sqlite3 "file://localhost$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "PRAGMA user_version"',
        'sqlite3 "FILE://$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "PRAGMA user_version"',
      ]) {
        await expect(detectUnsafeExecControlShellCommand(command, context)).resolves.toBe(
          "live-state-sqlite",
        );
      }

      // Parity with the private-copy allowance is preserved for URI spellings.
      const copiedDatabasePath = path.join(root, "snapshot", "openclaw.sqlite");
      await fs.mkdir(path.dirname(copiedDatabasePath), { recursive: true });
      await fs.writeFile(copiedDatabasePath, "fixture");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 "file:${copiedDatabasePath}?mode=ro"`,
          context,
        ),
      ).resolves.toBeNull();
      // A triple-slash private copy stays allowed.
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 "file://${copiedDatabasePath}?mode=ro"`,
          context,
        ),
      ).resolves.toBeNull();
    });
  });

  it("detects file: URI targets spelled with $HOME when state lives under HOME", async () => {
    await withTempDir("openclaw-exec-live-sqlite-home-", async (root) => {
      const stateDir = path.join(root, "home", ".openclaw");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "fixture");

      // The guard reads os.homedir(), not process.env.HOME, so mock it the way
      // other suites do (restored by afterEach restoreAllMocks).
      vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 "file:$HOME/.openclaw/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
          { stateDir, workdir: root },
        ),
      ).resolves.toBe("live-state-sqlite");
      // Bare $HOME form keeps working.
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 "$HOME/.openclaw/state/openclaw.sqlite" "PRAGMA user_version"',
          { stateDir, workdir: root },
        ),
      ).resolves.toBe("live-state-sqlite");
      // A $HOME URI outside the active state dir stays allowed.
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 "file:$HOME/snapshots/openclaw.sqlite?mode=ro"',
          { stateDir, workdir: root },
        ),
      ).resolves.toBeNull();
      // Relative file: URIs keep fileURLToPath semantics (root-relative), so a
      // private copy is not newly refused by this change even when the exec
      // workdir sits inside the state directory: resolving under workdir would
      // be a false refusal, root-relative resolution stays outside stateDir.
      const workdirInsideState = path.join(stateDir, "workspace");
      await expect(
        detectUnsafeExecControlShellCommand(
          `cd ${quote(root)} && sqlite3 "file:data/app.db?mode=ro" "SELECT 1"`,
          { stateDir, workdir: workdirInsideState },
        ),
      ).resolves.toBeNull();
      // A variable-bearing URI resolves the state directory even when the
      // workdir is inside the state directory.
      await expect(
        detectUnsafeExecControlShellCommand(
          `cd ${quote(root)} && sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro"`,
          { stateDir, workdir: workdirInsideState },
        ),
      ).resolves.toBe("live-state-sqlite");
    });
  });

  it("allows SQLite inspection of a private copy outside the active state directory", async () => {
    await withTempDir("openclaw-exec-copied-sqlite-", async (root) => {
      const stateDir = path.join(root, "state");
      const copiedDatabasePath = path.join(root, "snapshot", "openclaw.sqlite");
      await fs.mkdir(path.dirname(copiedDatabasePath), { recursive: true });
      await fs.writeFile(copiedDatabasePath, "fixture");

      await expect(
        detectUnsafeExecControlShellCommand(`sqlite3 ${quote(copiedDatabasePath)}`, {
          stateDir,
          workdir: root,
        }),
      ).resolves.toBeNull();
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 :memory: ${quote(`.open ${quote(copiedDatabasePath)}`)}`,
          { stateDir, workdir: root },
        ),
      ).resolves.toBeNull();
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 -cmd ${quote(`.open --readonly ${quote(copiedDatabasePath)}`)} :memory:`,
          { stateDir, workdir: root },
        ),
      ).resolves.toBeNull();
      await expect(
        detectUnsafeExecControlShellCommand(`cat ${quote(path.join(stateDir, "state.sqlite"))}`, {
          stateDir,
          workdir: root,
        }),
      ).resolves.toBeNull();
    });
  });

  it("rejects the live target before the external SQLite process starts", async () => {
    await withTempDir("openclaw-exec-live-sqlite-spawn-", async (root) => {
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "agents", "main", "state.sqlite");
      const markerPath = path.join(root, "sqlite-spawned");
      const sqlitePath = path.join(root, "sqlite3");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(sqlitePath, `#!/bin/sh\nprintf spawned > ${quote(markerPath)}\n`, {
        mode: 0o755,
      });

      await withEnvAsync(
        {
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const tool = createExecTool({
            host: "gateway",
            security: "full",
            ask: "on-miss",
            allowBackground: false,
          });
          await expect(
            tool.execute("call-live-sqlite", {
              command: `${quote(sqlitePath)} :memory: ${quote(`.open ${quote(databasePath)}`)}`,
              workdir: root,
            }),
          ).rejects.toThrow(
            /external sqlite3 cannot open databases under the active OpenClaw state directory/,
          );
        },
      );

      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a variable-bearing file: URI live target before spawn and runs a private-copy URI", async () => {
    await withTempDir("openclaw-exec-live-sqlite-uri-spawn-", async (root) => {
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const liveMarkerPath = path.join(root, "live-spawned");
      const sqlitePath = path.join(root, "sqlite3");
      // The guard is path-based; no database fixture is created at the live
      // location (a non-SQLite fixture there would poison the exec tool's own
      // state access and trip the security=deny fallback).
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(sqlitePath, `#!/bin/sh\nprintf spawned > ${quote(liveMarkerPath)}\n`, {
        mode: 0o755,
      });

      await withEnvAsync(
        {
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const tool = createExecTool({
            host: "gateway",
            security: "full",
            ask: "on-miss",
            allowBackground: false,
          });
          // Live target spelled through the variable-bearing file: URI form is
          // refused before the external process starts.
          await expect(
            tool.execute("call-live-sqlite-uri", {
              command: `${quote(sqlitePath)} "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"`,
              workdir: root,
            }),
          ).rejects.toThrow(
            /external sqlite3 cannot open databases under the active OpenClaw state directory/,
          );
          await expect(fs.stat(liveMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });

          // A private copy spelled as a file: URI outside the state directory
          // still executes end to end.
          const copiedDatabasePath = path.join(root, "snapshot", "openclaw.sqlite");
          await fs.mkdir(path.dirname(copiedDatabasePath), { recursive: true });
          await fs.writeFile(copiedDatabasePath, "fixture");
          const privateMarkerPath = path.join(root, "private-spawned");
          await fs.writeFile(
            sqlitePath,
            `#!/bin/sh\nprintf spawned > ${quote(privateMarkerPath)}\n`,
            { mode: 0o755 },
          );
          await tool.execute("call-private-sqlite-uri", {
            command: `${quote(sqlitePath)} "file:${copiedDatabasePath}?mode=ro" "PRAGMA user_version"`,
            workdir: root,
          });
          await expect(fs.stat(privateMarkerPath)).resolves.toBeDefined();
        },
      );
    });
  });
});
