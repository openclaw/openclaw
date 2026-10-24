import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import type {
  OrphanFixtureRequest,
  OrphanFixtureStart,
  OrphanFixtureTree as ProcessTree,
} from "./transport-orphan.test-helper.js";

const fixture = fileURLToPath(new URL("./transport-orphan.test-helper.ts", import.meta.url));
const nodeExecPath = resolveTestNodeExecPath();

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

function killFixtureProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // A test-owned process may already have been reaped by its successor.
  }
}

function expectTreesAlive(trees: Iterable<ProcessTree>, alive: boolean, childrenOnly = false) {
  const pids = [...trees].flatMap(({ child, descendant }) =>
    childrenOnly ? [child] : [child, descendant],
  );
  expect(pids.map(isAlive)).toEqual(pids.map(() => alive));
}

describe.skipIf(process.platform === "win32")("Codex stdio crash recovery", () => {
  let root: string;
  let stateDir: string;
  let unavailablePs: string;
  let survivor: ChildProcess;
  let live: ProcessTree;
  let other: ProcessTree;
  let nextNative = 0;
  const parents = new Set<ChildProcess>();
  const retainedTrees = new Set<ProcessTree>();
  const stderr = new WeakMap<ChildProcess, string>();

  function fixtureEnv(nativeEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      HOME: root,
      ...nativeEnv,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PATH: process.env.PATH,
      NODE_ENV: "test",
    };
  }

  function releaseTree(tree: ProcessTree) {
    for (const pid of [tree.descendant, tree.child]) {
      if (isAlive(pid)) {
        killFixtureProcess(pid);
      }
    }
    retainedTrees.delete(tree);
  }

  async function startOwner() {
    const parent = spawn(nodeExecPath, ["--import", "tsx", fixture], {
      env: fixtureEnv(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    parents.add(parent);
    parent.stderr?.on("data", (chunk: Buffer) => {
      stderr.set(parent, ((stderr.get(parent) ?? "") + chunk.toString()).slice(-4_000));
    });
    await once(parent, "spawn");
    return parent;
  }

  async function stopOwner(parent: ChildProcess) {
    if (parent.pid && parent.exitCode === null && parent.signalCode === null) {
      // Include children whose startup failed before they could report readiness.
      const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const owned = new Set([parent.pid]);
      for (const pid of owned) {
        for (const [child, owner] of rows) {
          if (owner === pid && child) {
            owned.add(child);
          }
        }
      }
      const exited = once(parent, "exit");
      for (const pid of [...owned].toReversed()) {
        killFixtureProcess(pid);
      }
      await exited;
    }
    parent.stderr?.destroy();
    parents.delete(parent);
  }

  async function request(parent: ChildProcess, message: OrphanFixtureRequest) {
    return await new Promise<ProcessTree | "closed">((resolve, reject) => {
      const cleanup = () => {
        parent.off("error", onError);
        parent.off("exit", onExit);
        parent.off("message", onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = () => onError(new Error(`Fixture exited: ${stderr.get(parent) ?? ""}`));
      const onMessage = (response: ProcessTree | "closed" | { error: string }) => {
        cleanup();
        if (typeof response === "object" && "error" in response) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      };
      parent.once("error", onError);
      parent.once("exit", onExit);
      parent.once("message", onMessage);
      parent.send!(message, (error) => {
        if (error) {
          onError(error);
        }
      });
    });
  }

  async function start(
    parent: ChildProcess,
    mode: "fixture" | "native",
    directory = stateDir,
    inspection: NodeJS.ProcessEnv = {},
  ) {
    const native =
      mode === "native"
        ? await createCodexNativeTestState(path.join(root, `native-${nextNative++}`))
        : undefined;
    if (native) {
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        'cli_auth_credentials_store="ephemeral"\n[features]\nrespect_system_proxy=false\nshell_snapshot=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n',
      );
    }
    const common = {
      kind: "start" as const,
      stateDir: directory,
      env: {
        ...fixtureEnv(native?.env),
        // Linux inspection reads procfs, so every start proves it never needs ps.
        PATH: process.platform === "linux" ? unavailablePs : process.env.PATH,
        ...inspection,
        OPENCLAW_STATE_DIR: directory,
        NODE_ENV: "test",
      },
    };
    const message: OrphanFixtureStart = native
      ? { ...common, mode: "native", command: native.command, cwd: native.cwd }
      : { ...common, mode: "fixture" };
    const tree = await request(parent, message);
    if (tree === "closed") {
      throw new Error("Fixture closed instead of starting a process tree");
    }
    retainedTrees.add(tree);
    return tree;
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-orphan-"));
    stateDir = path.join(root, "state");
    const fakeBin = path.join(root, "bin");
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    unavailablePs = `${fakeBin}${path.delimiter}${process.env.PATH}`;
    // Warm the surviving source runtime, native server and both state stores once per file.
    survivor = await startOwner();
    live = await start(survivor, "native");
    other = await start(survivor, "fixture", path.join(root, "other-state"));
  });

  afterAll(async () => {
    try {
      for (const parent of parents) {
        await stopOwner(parent);
      }
    } finally {
      // A crashed helper can leave reported children outside its former process tree.
      for (const tree of retainedTrees) {
        releaseTree(tree);
      }
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it(
    "reaps dead native and Node trees before a fresh spawn and preserves live owners",
    {
      timeout: 60_000,
    },
    async () => {
      // Only this doomed owner needs a cold process: registration verifies its actual OS parent.
      const owner = await startOwner();
      const orphans = new Set<ProcessTree>();
      const native = await start(owner, "native");
      orphans.add(native);
      orphans.add(await start(owner, "fixture"));
      expectTreesAlive(orphans, true, true);
      // Freeze the real app-server mid-command so EOF cannot complete its cleanup.
      process.kill(native.child, "SIGSTOP");
      const exited = once(owner, "exit");
      owner.kill("SIGKILL");
      await exited;
      expectTreesAlive(orphans, true);

      if (process.platform === "darwin") {
        // macOS inspection is native-only; proc-safe's documented off mode makes it unavailable.
        await expect(
          start(survivor, "fixture", stateDir, { PROC_SAFE_NATIVE: "off" }),
        ).rejects.toThrow(
          "Cannot inspect Codex processes. Process identity is unavailable or invalid.",
        );
        expectTreesAlive(orphans, true, true);
      }

      const fresh = await start(survivor, "fixture");
      expectTreesAlive(orphans, false);
      for (const tree of orphans) {
        retainedTrees.delete(tree);
      }
      expectTreesAlive([live, other, fresh], true);
      expect(await request(survivor, { kind: "close", child: fresh.child })).toBe("closed");
      expectTreesAlive([fresh], false);
      releaseTree(fresh);
    },
  );
});
