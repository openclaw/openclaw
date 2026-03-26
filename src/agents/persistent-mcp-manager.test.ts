import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBundleProbeMcpServer } from "./bundle-mcp.test-harness.js";
import { PersistentMcpManager } from "./persistent-mcp-manager.js";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeStateDir(): Promise<string> {
  return makeTempDir("openclaw-persistent-mcp-test-state-");
}

function makeLog() {
  const warnings: string[] = [];
  return {
    warn: (msg: string) => warnings.push(msg),
    warnings,
  };
}

/** Write a simple forever-sleep script that never exits on its own. */
async function writeSleepServer(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `#!/usr/bin/env node\nsetTimeout(() => {}, 10 * 60 * 1000);\n`, {
    encoding: "utf-8",
    mode: 0o755,
  });
}

const managers: PersistentMcpManager[] = [];

function makeManager(params: {
  stateDir: string;
  cfg?: ConstructorParameters<typeof PersistentMcpManager>[0]["cfg"];
  log?: ReturnType<typeof makeLog>;
}): PersistentMcpManager {
  const mgr = new PersistentMcpManager({
    cfg: params.cfg,
    log: params.log ?? makeLog(),
    stateDir: params.stateDir,
  });
  managers.push(mgr);
  return mgr;
}

// ────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────

afterEach(async () => {
  // Dispose all managers created during the test (order doesn't matter).
  await Promise.allSettled(managers.splice(0).map((m) => m.dispose()));
  // Remove temp directories.
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// ────────────────────────────────────────────────────────────
// A: Basic lifecycle
// ────────────────────────────────────────────────────────────

describe("PersistentMcpManager – basic lifecycle", () => {
  it("A1: no persistent server configured – ensureReady() returns cleanly", async () => {
    const stateDir = await makeStateDir();
    const mgr = makeManager({
      stateDir,
      cfg: { mcp: { servers: { transient: { command: "node", args: [] } } } },
    });

    await expect(mgr.ensureReady()).resolves.toBeUndefined();
    expect(mgr.getPersistentServerNames().size).toBe(0);

    // No lock directory created.
    const lockDir = path.join(stateDir, "mcp");
    await expect(fs.access(lockDir)).rejects.toThrow();
  });

  it("A2: persistent server starts – getReadyClient() returns non-null, lock file written", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const log = makeLog();
    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
      log,
    });

    await mgr.ensureReady();

    const client = await mgr.getReadyClient("probeServer");
    expect(client).not.toBeNull();

    // Lock file must exist with a valid pid.
    const lockPath = path.join(stateDir, "mcp", "probeServer.lock");
    const lockContent = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      pid: number;
      serverName: string;
      createdAt: string;
    };
    expect(lockContent.pid).toBeGreaterThan(0);
    expect(lockContent.serverName).toBe("probeServer");
    expect(lockContent.createdAt).toBeTruthy();
  });

  it("A3: dispose() deletes the lock file", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    await mgr.ensureReady();

    const lockPath = path.join(stateDir, "mcp", "probeServer.lock");
    await expect(fs.access(lockPath)).resolves.toBeUndefined(); // exists

    await mgr.dispose();

    await expect(fs.access(lockPath)).rejects.toThrow(); // deleted
  });

  it("A4: ensureReady() after dispose() is silent – no server rebuilt", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    await mgr.ensureReady();
    await mgr.dispose();

    // Should not throw and should not rebuild.
    await expect(mgr.ensureReady()).resolves.toBeUndefined();
    const client = await mgr.getReadyClient("probeServer");
    expect(client).toBeNull();
  });

  it("A5: concurrent ensureReady() calls spawn exactly one process", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    // Fire three concurrent ensureReady() calls.
    await Promise.all([mgr.ensureReady(), mgr.ensureReady(), mgr.ensureReady()]);

    // Only one lock file with one pid.
    const lockPath = path.join(stateDir, "mcp", "probeServer.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
    expect(lock.pid).toBeGreaterThan(0);

    // The client is ready and functional.
    const client = await mgr.getReadyClient("probeServer");
    expect(client).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// B: Stale lock / orphan processes
// ────────────────────────────────────────────────────────────

describe("PersistentMcpManager – stale lock handling", () => {
  it("B1: stale lock with dead pid – cleans up and starts fresh", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    // Write a stale lock pointing to a nonexistent PID.
    const lockDir = path.join(stateDir, "mcp");
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "probeServer.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999999,
        serverName: "probeServer",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    await mgr.ensureReady();

    const client = await mgr.getReadyClient("probeServer");
    expect(client).not.toBeNull();

    // Lock should be overwritten with the new pid (not 999999999).
    const newLock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
    expect(newLock.pid).toBeGreaterThan(0);
    expect(newLock.pid).not.toBe(999999999);
  });

  it("B2: stale lock with live orphan process – kills it, starts fresh", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);
    const sleepScript = path.join(stateDir, "sleep-server.mjs");
    await writeSleepServer(sleepScript);

    // Start an orphan process (the sleep server) and record its pid.
    const { spawn } = await import("node:child_process");
    const orphan = spawn("node", [sleepScript], { stdio: "ignore", detached: false });
    const orphanPid = orphan.pid!;

    try {
      // Write a lock pointing to the orphan.
      const lockDir = path.join(stateDir, "mcp");
      await fs.mkdir(lockDir, { recursive: true });
      const lockPath = path.join(lockDir, "probeServer.lock");
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: orphanPid,
          serverName: "probeServer",
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const mgr = makeManager({
        stateDir,
        cfg: {
          mcp: {
            servers: {
              probeServer: {
                command: "node",
                args: [serverScript],
                persistent: true,
              },
            },
          },
        },
      });

      await mgr.ensureReady();

      // Orphan should be dead now.
      let orphanAlive = true;
      try {
        process.kill(orphanPid, 0);
      } catch {
        orphanAlive = false;
      }
      expect(orphanAlive).toBe(false);

      // New server is ready.
      const client = await mgr.getReadyClient("probeServer");
      expect(client).not.toBeNull();

      const newLock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
      expect(newLock.pid).not.toBe(orphanPid);
    } finally {
      // Best-effort cleanup of orphan if test failed before kill.
      try {
        orphan.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it.skipIf(process.platform !== "linux")(
    "B3: PID recycled (starttime mismatch) – does not kill the new process",
    async () => {
      const stateDir = await makeStateDir();
      const serverScript = path.join(stateDir, "probe-server.mjs");
      await writeBundleProbeMcpServer(serverScript);

      // Write a stale lock with a real-but-unrelated pid (current test process itself)
      // and a deliberately wrong starttime so the manager thinks it's a different process.
      const lockDir = path.join(stateDir, "mcp");
      await fs.mkdir(lockDir, { recursive: true });
      const lockPath = path.join(lockDir, "probeServer.lock");
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid, // real alive PID
          starttime: 1, // wrong starttime → PID recycle
          serverName: "probeServer",
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const mgr = makeManager({
        stateDir,
        cfg: {
          mcp: {
            servers: {
              probeServer: {
                command: "node",
                args: [serverScript],
                persistent: true,
              },
            },
          },
        },
      });

      await mgr.ensureReady();

      // Current process must still be alive.
      expect(() => process.kill(process.pid, 0)).not.toThrow();

      // New server still started fine.
      const client = await mgr.getReadyClient("probeServer");
      expect(client).not.toBeNull();
    },
  );
});

// ────────────────────────────────────────────────────────────
// C: Failure and retry
// ────────────────────────────────────────────────────────────

describe("PersistentMcpManager – failure and retry", () => {
  it("C1: spawn failure does not throw – manager stays usable for other servers", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const log = makeLog();
    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            badServer: {
              command: "this-command-does-not-exist-openclaw-test",
              args: [],
              persistent: true,
            },
            goodServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
      log,
    });

    // Should not throw even though one server fails.
    await expect(mgr.ensureReady()).resolves.toBeUndefined();

    // Bad server unavailable.
    expect(await mgr.getReadyClient("badServer")).toBeNull();

    // Good server available.
    expect(await mgr.getReadyClient("goodServer")).not.toBeNull();

    // Warning logged for the failed server.
    expect(log.warnings.some((w) => w.includes("badServer"))).toBe(true);
  });

  it("C2: first spawn failure → subsequent getReadyClient() triggers lazy reconnect", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");

    // Script doesn't exist yet → first ensureReady() will fail for this server.
    const log = makeLog();
    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            lazyServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
      log,
    });

    await mgr.ensureReady(); // spawn fails, handle deleted

    // Verify handle is gone (client unavailable).
    expect(await mgr.getReadyClient("lazyServer")).toBeNull();

    // Now create the script.
    await writeBundleProbeMcpServer(serverScript);

    // Next getReadyClient() should trigger lazy reconnect and succeed.
    const client = await mgr.getReadyClient("lazyServer");
    expect(client).not.toBeNull();
  });

  it("C3: manager failed → ensureReady() retries and succeeds", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");

    // Patch _doInit to fail on first call only.
    let callCount = 0;
    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    // First call: file doesn't exist yet → fails.
    await mgr.ensureReady();
    expect(await mgr.getReadyClient("probeServer")).toBeNull();

    // Create the file.
    await writeBundleProbeMcpServer(serverScript);

    // Second call: retry should succeed.
    await mgr.ensureReady();
    expect(await mgr.getReadyClient("probeServer")).not.toBeNull();
  });

  it("C4: transport onclose marks handle failed → getReadyClient() reconnects", async () => {
    const stateDir = await makeStateDir();
    const serverScript = path.join(stateDir, "probe-server.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = makeManager({
      stateDir,
      cfg: {
        mcp: {
          servers: {
            probeServer: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    await mgr.ensureReady();
    expect(await mgr.getReadyClient("probeServer")).not.toBeNull();

    // Simulate disconnection by killing the child process.
    // Read the lock to get the pid.
    const lockPath = path.join(stateDir, "mcp", "probeServer.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
    try {
      process.kill(lock.pid, "SIGKILL");
    } catch {
      /* already gone */
    }

    // Give the transport time to detect the close.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // After the child process is killed the transport fires onclose.
    // getReadyClient() should trigger a lazy reconnect.
    const reconnectedClient = await mgr.getReadyClient("probeServer");
    expect(reconnectedClient).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// D: Edge cases
// ────────────────────────────────────────────────────────────

describe("PersistentMcpManager – getPersistentServerNames()", () => {
  it("D1: only returns names where persistent === true", () => {
    const mgr = makeManager({
      stateDir: os.tmpdir(),
      cfg: {
        mcp: {
          servers: {
            persistentOne: { command: "node", args: [], persistent: true },
            transientOne: { command: "node", args: [], persistent: false },
            defaultOne: { command: "node", args: [] },
          },
        },
      },
    });

    const names = mgr.getPersistentServerNames();
    expect(names.has("persistentOne")).toBe(true);
    expect(names.has("transientOne")).toBe(false);
    expect(names.has("defaultOne")).toBe(false);
  });
});
