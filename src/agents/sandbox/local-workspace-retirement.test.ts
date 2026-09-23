import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as bridgeApi from "../../plugin-sdk/browser-bridge.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { BROWSER_BRIDGES, type CachedBrowserBridge } from "./browser-bridges.js";
import * as engine from "./container-engine.js";
import { quiesceLocalWorkspace } from "./local-workspace-quiescence.js";
import * as registry from "./registry.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const oldId = "a".repeat(64);
const newId = "b".repeat(64);
const entry = {
  containerName: "retire-owned",
  backendId: "docker",
  sessionKey: "owner",
  workspaceDir: "/projection",
  createdAtMs: 1,
  lastUsedAtMs: 1,
  image: "fixture",
  cdpPort: 9222,
};
function bridge(): CachedBrowserBridge {
  return {
    containerName: entry.containerName,
    bridge: {
      server: createServer(),
      port: 0,
      baseUrl: "http://127.0.0.1",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: false,
          controlPort: 0,
          cdpPortRangeStart: 0,
          cdpPortRangeEnd: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          remoteCdpTimeoutMs: 1000,
          remoteCdpHandshakeTimeoutMs: 1000,
          localLaunchTimeoutMs: 1000,
          localCdpReadyTimeoutMs: 1000,
          actionTimeoutMs: 1000,
          color: "#000000",
          headless: true,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "fixture",
          profiles: {},
          extraArgs: [],
          tabCleanup: { enabled: false, idleMinutes: 1, maxTabsPerSession: 1, sweepMinutes: 1 },
        },
      },
    },
  };
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dirs.make("openclaw-retirement-"), "state"));
  BROWSER_BRIDGES.clear();
  vi.spyOn(bridgeApi, "stopBrowserBridgeServer").mockResolvedValue(undefined);
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  BROWSER_BRIDGES.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(kind: "container" | "browser", running = true) {
  await (kind === "container"
    ? registry.updateRegistry(entry)
    : registry.updateBrowserRegistry(entry));
  const capturedBridge = bridge();
  if (kind === "browser") {
    BROWSER_BRIDGES.set(entry.sessionKey, capturedBridge);
  }
  const physical = new Set([oldId]);
  let named = oldId;
  let afterRemove = async () => {};
  const command = vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    const target = args.at(-1) === entry.containerName ? named : args.at(-1)!;
    if (args[0] === "inspect") {
      if (!physical.has(target)) {
        return { code: 1, stdout: "", stderr: "no such container" };
      }
      return {
        code: 0,
        stdout: args.includes("{{.Id}}")
          ? target
          : args.includes("{{.State.Paused}}")
            ? "false"
            : target + " " + running + " false",
        stderr: "",
      };
    }
    if (args[0] === "rm") {
      physical.delete(target);
      await afterRemove();
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  let current = true;
  const custody = await quiesceLocalWorkspace({
    workspaceDir: entry.workspaceDir,
    retained: [],
    persist: () => {},
    assertCurrent: () => {
      if (!current) {
        throw new Error("lease revoked");
      }
    },
  });
  const replacePhysical = () => {
    physical.delete(oldId);
    physical.add(newId);
    named = newId;
  };
  const replace = async () => {
    replacePhysical();
    if (kind === "container") {
      await registry.removeRegistryEntry(entry.containerName);
      await registry.updateRegistry({ ...entry, createdAtMs: 2 });
    } else {
      await registry.removeBrowserRegistryEntry(entry.containerName);
      await registry.updateBrowserRegistry({ ...entry, createdAtMs: 2 });
    }
  };
  const rows = async () =>
    (kind === "container" ? await registry.readRegistry() : await registry.readBrowserRegistry())
      .entries;
  return {
    custody,
    physical,
    command,
    capturedBridge,
    rows,
    replace,
    replacePhysical,
    revoke: () => {
      current = false;
    },
    onRemove: (fn: () => Promise<void>) => {
      afterRemove = fn;
    },
  };
}

it.each(["container", "browser"] as const)(
  "retires running and stopped %s allocations by their captured IDs",
  async (kind) => {
    for (const running of [true, false]) {
      const h = await setup(kind, running);
      await h.custody.retire();
      await h.custody.resume();
      expect(h.physical.size).toBe(0);
      expect(
        h.command.mock.calls.filter(([, args]) => args[0] === "rm").map(([, args]) => args.at(-1)),
      ).toEqual([oldId]);
      expect(h.command.mock.calls.some(([, args]) => args[0] === "pause")).toBe(running);
      expect(await h.rows()).toEqual([]);
      expect(BROWSER_BRIDGES.size).toBe(0);
      h.command.mockRestore();
    }
  },
);
it.each(["container", "browser"] as const)(
  "preserves replacement %s custody during awaited removal",
  async (kind) => {
    const h = await setup(kind);
    h.onRemove(h.replace);
    await expect(h.custody.retire()).rejects.toThrow(/generation|owner changed/);
    expect(h.physical.has(newId)).toBe(true);
    expect(await h.rows()).toMatchObject([{ createdAtMs: 2 }]);
    expect(bridgeApi.stopBrowserBridgeServer).not.toHaveBeenCalled();
  },
);
it.each(["container", "browser"] as const)(
  "rejects revoked %s custody after physical removal without dropping metadata",
  async (kind) => {
    const h = await setup(kind);
    h.onRemove(async () => h.revoke());
    await expect(h.custody.retire()).rejects.toThrow("lease revoked");
    expect(await h.rows()).toHaveLength(1);
    expect(bridgeApi.stopBrowserBridgeServer).not.toHaveBeenCalled();
  },
);
it.each(["before", "during"] as const)(
  "preserves a replacement bridge installed %s captured bridge shutdown",
  async (when) => {
    const h = await setup("browser");
    const replacement = bridge();
    const replace = async () => {
      BROWSER_BRIDGES.set(entry.sessionKey, replacement);
    };
    if (when === "before") {
      await replace();
    } else {
      vi.mocked(bridgeApi.stopBrowserBridgeServer).mockImplementationOnce(replace);
    }
    await expect(h.custody.retire()).rejects.toThrow("bridge generation");
    expect(BROWSER_BRIDGES.get(entry.sessionKey)).toBe(replacement);
    expect(bridgeApi.stopBrowserBridgeServer).not.toHaveBeenCalledWith(replacement.bridge.server);
    expect(await h.rows()).toHaveLength(1);
    expect(h.physical.has(oldId)).toBe(when === "before");
  },
);

it("preserves metadata when only the physical name is rebound during bridge shutdown", async () => {
  const h = await setup("browser");
  vi.mocked(bridgeApi.stopBrowserBridgeServer).mockImplementationOnce(async () =>
    h.replacePhysical(),
  );
  await expect(h.custody.retire()).rejects.toThrow("generation");
  expect(h.physical.has(newId)).toBe(true);
  expect(await h.rows()).toHaveLength(1);
});

it.each(["container", "browser"] as const)(
  "forgets confirmed-absent %s metadata without destructive name fallback",
  async (kind) => {
    const h = await setup(kind, false);
    h.physical.clear();
    const missing = await quiesceLocalWorkspace({
      workspaceDir: entry.workspaceDir,
      retained: [],
      persist: () => {},
      assertCurrent: () => {},
    });
    h.command.mockClear();
    await missing.retire();
    expect(h.command.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
    expect(await h.rows()).toEqual([]);
  },
);
