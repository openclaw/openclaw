import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeBundleProbeMcpServer, writeClaudeBundle } from "./bundle-mcp.test-harness.js";
import { PersistentMcpManager } from "./persistent-mcp-manager.js";
import {
  createBundleMcpToolRuntime,
  createEmbeddedBundleMcpRuntime,
  getPersistentMcpManager,
  setPersistentMcpManager,
} from "./pi-bundle-mcp-tools.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const managersToDispose: PersistentMcpManager[] = [];

afterEach(async () => {
  // Restore singleton.
  setPersistentMcpManager(null);
  // Dispose any managers created during tests.
  await Promise.allSettled(managersToDispose.splice(0).map((m) => m.dispose()));
  // Remove temp dirs.
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createBundledRuntime(options?: { reservedToolNames?: string[] }) {
  const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
  const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
  await writeBundleProbeMcpServer(serverScriptPath);
  await writeClaudeBundle({ pluginRoot, serverScriptPath });

  return createBundleMcpToolRuntime({
    workspaceDir,
    cfg: {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    },
    reservedToolNames: options?.reservedToolNames,
  });
}

// ─── helpers shared by E-tests ────────────────────────────────────────────

async function makeStateDir(): Promise<string> {
  return makeTempDir("openclaw-persistent-mcp-state-");
}

async function makeWorkspaceDir(): Promise<string> {
  return makeTempDir("openclaw-embedded-mcp-workspace-");
}

/**
 * Start a real PersistentMcpManager backed by `serverScript`, register it as
 * the singleton, and return it (also queued for afterEach disposal).
 */
async function startPersistentManager(params: {
  serverName: string;
  serverScript: string;
  stateDir: string;
}): Promise<PersistentMcpManager> {
  const mgr = new PersistentMcpManager({
    cfg: {
      mcp: {
        servers: {
          [params.serverName]: {
            command: "node",
            args: [params.serverScript],
            env: { BUNDLE_PROBE_TEXT: "FROM-PERSISTENT" },
            persistent: true,
          },
        },
      },
    },
    log: { warn: () => {} },
    stateDir: params.stateDir,
  });
  managersToDispose.push(mgr);
  await mgr.ensureReady();
  setPersistentMcpManager(mgr);
  return mgr;
}

describe("createBundleMcpToolRuntime", () => {
  it("loads bundle MCP tools and executes them", async () => {
    const runtime = await createBundledRuntime();

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
      const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-BUNDLE",
      });
      expect(result.details).toEqual({
        mcpServer: "bundleProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("skips bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await createBundledRuntime({ reservedToolNames: ["bundle_probe"] });

    try {
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured stdio MCP tools without a bundle", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
      const result = await runtime.tools[0].execute(
        "call-configured-probe",
        {},
        undefined,
        undefined,
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-CONFIG",
      });
      expect(result.details).toEqual({
        mcpServer: "configuredProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createEmbeddedBundleMcpRuntime
// ─────────────────────────────────────────────────────────────────────────────

describe("createEmbeddedBundleMcpRuntime", () => {
  it("E1: no manager (singleton=null) – behaves like createBundleMcpToolRuntime", async () => {
    // Singleton is already null from afterEach.
    expect(getPersistentMcpManager()).toBeNull();

    const workspaceDir = await makeWorkspaceDir();
    const serverScript = path.join(workspaceDir, "probe.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const runtime = await createEmbeddedBundleMcpRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            transientProbe: {
              command: "node",
              args: [serverScript],
              env: { BUNDLE_PROBE_TEXT: "FROM-TRANSIENT" },
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((t) => t.name)).toEqual(["bundle_probe"]);
      const result = await runtime.tools[0].execute("e1", {}, undefined, undefined);
      expect(result.content[0]).toMatchObject({ type: "text", text: "FROM-TRANSIENT" });
    } finally {
      await runtime.dispose();
    }
  });

  it("E2: manager ready – persistent tools appear, transient dispose does not close persistent", async () => {
    const stateDir = await makeStateDir();
    const workspaceDir = await makeWorkspaceDir();
    const persistentScript = path.join(stateDir, "persistent.mjs");
    const transientScript = path.join(workspaceDir, "transient.mjs");
    await writeBundleProbeMcpServer(persistentScript);
    await writeBundleProbeMcpServer(transientScript);

    const mgr = await startPersistentManager({
      serverName: "persistentProbe",
      serverScript: persistentScript,
      stateDir,
    });

    const runtime = await createEmbeddedBundleMcpRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            persistentProbe: {
              command: "node",
              args: [persistentScript],
              persistent: true,
            },
            transientProbe: {
              command: "node",
              args: [transientScript],
              env: { BUNDLE_PROBE_TEXT: "FROM-TRANSIENT" },
            },
          },
        },
      },
    });

    try {
      const names = runtime.tools.map((t) => t.name);
      expect(names).toContain("bundle_probe");
      // Persistent tool listed (may be deduplicated with transient — persistent wins).
      expect(names.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose(); // disposes transient only
    }

    // Persistent client still alive after transient dispose.
    const client = await mgr.getReadyClient("persistentProbe");
    expect(client).not.toBeNull();
  });

  it("E3 (bug1): listTools failure on persistent server – tools absent, transient does NOT re-spawn it", async () => {
    const stateDir = await makeStateDir();
    const workspaceDir = await makeWorkspaceDir();
    const serverScript = path.join(stateDir, "probe.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = await startPersistentManager({
      serverName: "faultyPersistent",
      serverScript,
      stateDir,
    });

    // Patch listTools on the client to throw.
    const client = await mgr.getReadyClient("faultyPersistent");
    expect(client).not.toBeNull();
    vi.spyOn(client!, "listTools").mockRejectedValue(new Error("simulated listTools failure"));

    const transientSpawnedServers: string[] = [];
    const runtime = await createEmbeddedBundleMcpRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            faultyPersistent: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    try {
      // Persistent tool absent (listTools failed).
      expect(runtime.tools).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
    // No transient spawn of faultyPersistent happened — ownedServerNames contained it.
    // (Verified by absence of tools; a transient spawn would add bundle_probe.)
  });

  it("E4: getReadyClient returns null – tools absent, transient does NOT re-spawn", async () => {
    const stateDir = await makeStateDir();
    const workspaceDir = await makeWorkspaceDir();
    const serverScript = path.join(stateDir, "probe.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = await startPersistentManager({
      serverName: "unavailablePersistent",
      serverScript,
      stateDir,
    });

    // Make getReadyClient return null.
    vi.spyOn(mgr, "getReadyClient").mockResolvedValue(null);

    const runtime = await createEmbeddedBundleMcpRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            unavailablePersistent: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    try {
      // No tools — persistent unavailable and should NOT fall through to transient.
      expect(runtime.tools).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("E5: persistent and transient expose same tool name – transient copy skipped", async () => {
    const stateDir = await makeStateDir();
    const workspaceDir = await makeWorkspaceDir();
    const serverScript = path.join(stateDir, "probe.mjs");
    await writeBundleProbeMcpServer(serverScript);

    // Both persistent and transient expose "bundle_probe".
    await startPersistentManager({
      serverName: "persistentProbe",
      serverScript,
      stateDir,
    });

    const transientScript = path.join(workspaceDir, "transient.mjs");
    await writeBundleProbeMcpServer(transientScript);

    const runtime = await createEmbeddedBundleMcpRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            persistentProbe: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
            transientProbe: {
              command: "node",
              args: [transientScript],
              // non-persistent, also exposes bundle_probe
            },
          },
        },
      },
    });

    try {
      // bundle_probe appears exactly once (from persistent).
      const names = runtime.tools.map((t) => t.name);
      expect(names.filter((n) => n === "bundle_probe")).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("E6: dispose() only tears down transient part – persistent client stays usable", async () => {
    const stateDir = await makeStateDir();
    const workspaceDir = await makeWorkspaceDir();
    const serverScript = path.join(stateDir, "probe.mjs");
    await writeBundleProbeMcpServer(serverScript);

    const mgr = await startPersistentManager({
      serverName: "persistentProbe",
      serverScript,
      stateDir,
    });

    const runtime = await createEmbeddedBundleMcpRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            persistentProbe: {
              command: "node",
              args: [serverScript],
              persistent: true,
            },
          },
        },
      },
    });

    await runtime.dispose();

    // Manager's client is still alive after runtime.dispose().
    const client = await mgr.getReadyClient("persistentProbe");
    expect(client).not.toBeNull();

    // Can still list tools via the manager's client.
    const { tools } = await client!.listTools();
    expect(tools.some((t) => t.name === "bundle_probe")).toBe(true);
  });
});
