import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { detectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { validateScriptFileForShellBleed } from "./bash-tools.exec-script-preflight.js";
import { readToolEffectReceipt } from "./tool-effect-receipt.js";

const processGatewayAllowlistMock = vi.hoisted(() =>
  vi.fn<typeof processGatewayAllowlist>(async () => ({ allowWithoutEnforcedCommand: true })),
);
vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>()),
  processGatewayAllowlist: processGatewayAllowlistMock,
}));
vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by script preflight tests");
  },
}));
vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const isWin = process.platform === "win32";
const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;
// Commands settle before their fixture cwd is removed.
const createPreflightTool = () =>
  createExecTool({ host: "gateway", security: "full", ask: "on-miss", allowBackground: false });
const runExecPreflight = (command: string, workdir = process.cwd()) =>
  createPreflightTool().execute("call-script-preflight", { command, workdir });
const injection = /exec preflight: detected likely shell variable injection \(\$DM_JSON\)/;
const withScripts = <T>(files: Record<string, string>, run: (workdir: string) => Promise<T>) =>
  withTempDir("openclaw-exec-preflight-", async (workdir) => {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(workdir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, source, "utf-8");
    }
    return await run(workdir);
  });
const execScripts = (command: string, files: Record<string, string>) =>
  withScripts(files, (workdir) => runExecPreflight(command, workdir));
async function expectNotStarted(
  result: ReturnType<typeof runExecPreflight>,
  message: string | RegExp,
) {
  await expect(result).rejects.toThrow(message);
  await expect(result).rejects.toSatisfy(
    (error) => readToolEffectReceipt(error)?.state === "not_started",
  );
}

afterEach(() => __setFsSafeTestHooksForTest());
beforeEach(() => {
  processGatewayAllowlistMock.mockReset();
  processGatewayAllowlistMock.mockResolvedValue({ allowWithoutEnforcedCommand: true });
});

it("blocks interactive channel login commands from exec", async () => {
  for (const command of [
    "openclaw channels login --channel whatsapp --verbose",
    "pnpm exec openclaw channels login --channel whatsapp",
    "sudo -u openclaw bash -lc 'openclaw channels login --channel whatsapp'",
    "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
    "env env env env env env openclaw channels login --channel whatsapp",
    "env -S 'openclaw channels' login --channel whatsapp",
  ]) {
    await expect(runExecPreflight(command)).rejects.toThrow(
      /exec cannot run interactive OpenClaw channel login commands/,
    );
  }
});

describeNonWin("exec script preflight", () => {
  it("releases prepared launch authority when approval preparation finishes after cancellation", async () => {
    const controller = new AbortController();
    const releaseSpawn = vi.fn();
    processGatewayAllowlistMock.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during approval preparation"));
      return { allowWithoutEnforcedCommand: true, releaseSpawn };
    });
    await expect(
      createPreflightTool().execute(
        "cancelled-preparation",
        { command: "echo must-not-launch" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled during approval preparation");
    expect(releaseSpawn).toHaveBeenCalledOnce();
  });

  it.each([
    ["$P", 'result = f"{ "$A" + $P }"'],
    ["$A", 'result = f"\\{$A}"'],
    ["$F", 'result = f"{lambda value: $F}"'],
    ["$E", 'text = "ok\rpayload = $E'],
  ])("blocks Python shell variable %s in %s", async (token, source) => {
    await expectNotStarted(
      execScripts("python bad.py", { "bad.py": source }),
      `exec preflight: detected likely shell variable injection (${token})`,
    );
  });

  it("allows dollar text in Python strings, comments, and f-string format text", async () => {
    const result = await execScripts("python3 valid.py", {
      "valid.py": [
        'value = "$A"',
        "other = '''$_'''",
        'raw = r"$Q"',
        'hash_text = "# $R"',
        "nested = f\"{ '$S' }\"",
        'braces = f"{{ $T }}"',
        'continued = "text \\\r\n$U"',
        "class Echo:",
        "    def __format__(self, spec):",
        "        return spec",
        'format_text = f"{Echo():$W}"',
        "élambda = Echo()",
        'unicode_format = f"{élambda:$Y}"',
        "# $P",
        'print(f"{value}:{other}:{raw}:{hash_text}:{nested}:{braces}:{continued}:{format_text}:{unicode_format}")',
      ].join("\n"),
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: "$A:$_:$Q:# $R:$S:{ $T }:text $U:$W:$Y",
    });
  });

  it("lets Node execute valid dollar identifiers and labels in preloads and entrypoints", async () => {
    const result = await execScripts("env node --require ./bootstrap.js app.js config.js", {
      "bootstrap.js": 'const $VALUE = "preload:"; process.stdout.write($VALUE);',
      "app.js":
        '// $COMMENT\nconst $A = "a", $_ = "b"; NODE: { process.stdout.write($A + $_ + "$HOME" + `$TMPDIR`); }',
      "config.js": 'throw new Error("argument is not a script");',
    });
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "preload:ab$HOME$TMPDIR",
    });
  });

  it("validates scripts under literal tilde directories", async () => {
    await expect(
      execScripts('python3 "~/bad.py"', { "~/bad.py": "payload = $DM_JSON" }),
    ).rejects.toThrow(injection);
  });

  it("skips preflight reads outside workdir", async () => {
    await withScripts(
      { "outside.py": "payload = $DM_JSON", "workdir/inside.py": "" },
      async (parent) => {
        await expect(
          runExecPreflight("python3 ../outside.py", path.join(parent, "workdir")),
        ).resolves.toBeDefined();
      },
    );
  });

  it.each(["afterPreOpenLstat", "beforeOpen"] as const)(
    "does not trust symlink swaps at %s",
    async (hookName) => {
      await withScripts(
        { "workdir/script.py": 'print("inside")', "outside.py": "payload = $DM_JSON" },
        async (parent) => {
          const workdir = path.join(parent, "workdir");
          const scriptPath = path.join(workdir, "script.py");
          const scriptRealPath = await fs.realpath(scriptPath);
          let swapped = false;
          __setFsSafeTestHooksForTest({
            [hookName]: async (target: string) => {
              if (swapped || path.resolve(target) !== scriptRealPath) {
                return;
              }
              await fs.rm(scriptPath, { force: true });
              await fs.symlink(path.join(parent, "outside.py"), scriptPath);
              swapped = true;
            },
          });
          await expect(runExecPreflight("python3 script.py", workdir)).resolves.toBeDefined();
          expect(swapped).toBe(true);
        },
      );
    },
  );

  it("opens script reads with O_NONBLOCK to avoid FIFO stalls", async () => {
    await withScripts({ "script.py": 'print("ok")' }, async (workdir) => {
      const scriptRealPath = await fs.realpath(path.join(workdir, "script.py"));
      const scriptOpenFlags: number[] = [];
      __setFsSafeTestHooksForTest({
        beforeOpen: (target, flags) => {
          if (path.resolve(target) === scriptRealPath) {
            scriptOpenFlags.push(flags);
          }
        },
      });
      await expect(runExecPreflight("python3 script.py", workdir)).resolves.toBeDefined();
      expect(scriptOpenFlags).not.toStrictEqual([]);
      expect(scriptOpenFlags.every((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
    });
  });

  it.each([
    "cat bad.py | python",
    'bash -c "node bad.js"',
    "node <(cat bad.js)",
    'if true; then\npython "bad.py"\nfi',
    `env /bin/bash --rcfile shell.rc --noprofile --norc -O extglob -ceu "python 'bad.py'"`,
  ])("fails closed for %s", async (command) => {
    await expectNotStarted(
      runExecPreflight(command),
      /exec preflight: complex interpreter invocation detected/,
    );
  });

  it.each([
    "node --version && ls *.py",
    "node -e \"console.log('bad.py')\" | cat",
    "echo python bad.py \\| node",
  ])("does not reject non-script interpreter hints in %s", async (command) => {
    await expect(runExecPreflight(command)).resolves.toBeDefined();
  });
});

describeWin("exec script preflight on Windows paths", () => {
  it.each(["relative", "absolute"])("validates Python %s paths", async (kind) => {
    await withScripts({ "subdir/bad.py": "payload = $DM_JSON" }, async (workdir) => {
      const script =
        kind === "relative"
          ? "subdir\\bad.py"
          : path.join(workdir, "subdir", "bad.py").replaceAll("/", "\\");
      await expect(runExecPreflight(`python "${script}"`, workdir)).rejects.toThrow(injection);
    });
  });
  it("runs valid JavaScript through a Windows relative path", async () => {
    const result = await execScripts("node .\\valid.js", {
      "valid.js": 'const $FOO = "ok"; process.stdout.write($FOO);',
    });
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "ok",
    });
  });
});

it("does not hang on assignment prefixes followed by whitespace-heavy text", async () => {
  const htmlBlock = '<section style="padding: 30px 20px; font-family: Arial;">'.repeat(50);
  const command = `ACCESS_TOKEN=$(__openclaw_missing_redos_guard__)\nprintf '%s' '${htmlBlock}' >/dev/null`;
  const start = Date.now();
  await validateScriptFileForShellBleed({ command, workdir: process.cwd() });
  expect(Date.now() - start).toBeLessThan(5000);
});

describeNonWin("exec live OpenClaw state SQLite guard", () => {
  const quote = (value: string) => JSON.stringify(value);

  async function databaseFixture(root: string, relativePath: string) {
    const databasePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "fixture");
    return databasePath;
  }

  const tempDirs = createTempDirTracker();

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
    tempDirs.cleanup();
  });

  describe("target analysis", () => {
    let root: string, stateDir: string, databasePath: string;
    async function check(
      commands: string[],
      expected: "live-state-sqlite" | null = "live-state-sqlite",
      workdir = root,
    ) {
      for (const command of commands) {
        await expect(
          detectUnsafeExecControlShellCommand(command, { stateDir, workdir }),
        ).resolves.toBe(expected);
      }
    }
    beforeEach(async () => {
      root = tempDirs.make("openclaw-exec-live-sqlite-");
      stateDir = path.join(root, "state with spaces");
      databasePath = await databaseFixture(stateDir, "state/openclaw.sqlite");
    });
    it("detects direct and carrier-wrapped SQLite targets under the active state directory", async () => {
      await check([
        `sqlite3 --json ${quote(databasePath)}`,
        `sudo -u openclaw env sqlite3 -header -column ${quote(databasePath)}`,
        'sqlite3 -cmd ".timeout 1000" "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"',
        `sqlite3 :memory: ${quote(`.open ${quote(databasePath)}`)}`,
        `sqlite3 :memory: ${quote(`.op ${quote(databasePath)}`)}`,
        `sqlite3 -cmd ${quote(`.open --readonly ${quote(databasePath)}`)} :memory:`,
      ]);
      await check([`cat ${quote(databasePath)}`], null);
    });

    it("detects relative and symlink-aliased live state targets", async () => {
      const aliasDir = path.join(root, "state-alias");
      await databaseFixture(stateDir, "agents/main/state.sqlite");
      await fs.symlink(stateDir, aliasDir);
      await check([
        'sqlite3 "state with spaces/agents/main/state.sqlite"',
        `sqlite3 --readonly ${quote(path.join(aliasDir, "agents", "main", "state.sqlite"))}`,
      ]);
    });

    it("detects live state targets hidden behind file: URI variable spellings", async () => {
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

    it("detects file: URI targets spelled with $HOME when state lives under HOME", async () => {
      stateDir = path.join(root, "home", ".openclaw");
      await databaseFixture(stateDir, "state/openclaw.sqlite");
      // The guard reads os.homedir(), not process.env.HOME.
      vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
      await check([
        'sqlite3 "file:$HOME/.openclaw/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "$HOME/.openclaw/state/openclaw.sqlite" "PRAGMA user_version"',
      ]);
      await check(['sqlite3 "file:$HOME/snapshots/openclaw.sqlite?mode=ro"'], null);
      // Relative file URIs are root-relative, not relative to the exec workdir.
      await check(
        [`cd ${quote(root)} && sqlite3 "file:data/app.db?mode=ro" "SELECT 1"`],
        null,
        path.join(stateDir, "workspace"),
      );
      await check(
        [`cd ${quote(root)} && sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro"`],
        "live-state-sqlite",
        path.join(stateDir, "workspace"),
      );
    });
  });

  it.each([false, true])("rejects live SQLite before spawn (URI=%s)", async (uri) => {
    await withSpawnFixture(
      "state/openclaw.sqlite",
      async ({ root, databasePath, sqlitePath, markerPath, tool }) => {
        const target = uri
          ? '"file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"'
          : `:memory: ${quote(`.open ${quote(databasePath)}`)}`;
        await expect(
          tool.execute("call-live-sqlite-uri", {
            command: `${quote(sqlitePath)} ${target}`,
            workdir: root,
          }),
        ).rejects.toThrow(
          /external sqlite3 cannot open databases under the active OpenClaw state directory/,
        );
        await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        if (!uri) {
          return;
        }
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
