import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentMcpManager } from "./persistent-mcp-manager.js";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  writeBundleProbeMcpServer,
} from "./pi-bundle-mcp-test-harness.js";
import {
  createEmbeddedBundleMcpRuntime,
  getPersistentMcpManager,
  setPersistentMcpManager,
} from "./pi-bundle-mcp-tools.js";

const managersToDispose: PersistentMcpManager[] = [];

afterEach(async () => {
  // Restore singleton.
  setPersistentMcpManager(null);
  // Dispose any managers created during tests.
  await Promise.allSettled(managersToDispose.splice(0).map((m) => m.dispose()));
  // Cleanup temp dirs and session runtimes.
  await cleanupBundleMcpHarness();
});

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

// ─────────────────────────────────────────────────────────────────────────────
// createEmbeddedBundleMcpRuntime
// ─────────────────────────────────────────────────────────────────────────────

describe("createEmbeddedBundleMcpRuntime", () => {
  it("E1: no manager (singleton=null) – behaves like createBundleMcpToolRuntime", async () => {
    // Singleton is already null from afterEach.
    expect(getPersistentMcpManager()).toBeNull();

    const workspaceDir = await makeTempDir("openclaw-embedded-mcp-workspace-");
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
      expect(runtime.tools.map((t) => t.name).some((n) => n.includes("bundle_probe"))).toBe(true);
      const tool = runtime.tools[0];
      const result = await tool.execute("e1", {}, undefined, undefined);
      expect(result.content[0]).toMatchObject({ type: "text", text: "FROM-TRANSIENT" });
    } finally {
      await runtime.dispose();
    }
  });

  it("E2: manager ready – persistent tools appear, transient dispose does not close persistent", async () => {
    const stateDir = await makeTempDir("openclaw-persistent-mcp-state-");
    const workspaceDir = await makeTempDir("openclaw-embedded-mcp-workspace-");
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
    const stateDir = await makeTempDir("openclaw-persistent-mcp-state-");
    const workspaceDir = await makeTempDir("openclaw-embedded-mcp-workspace-");
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
    const stateDir = await makeTempDir("openclaw-persistent-mcp-state-");
    const workspaceDir = await makeTempDir("openclaw-embedded-mcp-workspace-");
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
    const stateDir = await makeTempDir("openclaw-persistent-mcp-state-");
    const workspaceDir = await makeTempDir("openclaw-embedded-mcp-workspace-");
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
    const stateDir = await makeTempDir("openclaw-persistent-mcp-state-");
    const workspaceDir = await makeTempDir("openclaw-embedded-mcp-workspace-");
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
