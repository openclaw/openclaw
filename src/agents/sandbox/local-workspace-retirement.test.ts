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
const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
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
      get state(): never {
        throw new Error("Retirement must use server identity, not browser configuration");
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
const quiesce = (assertCurrent = () => {}, env?: NodeJS.ProcessEnv) =>
  quiesceLocalWorkspace({
    env,
    workspaceDir: entry.workspaceDir,
    retained: [],
    persist: () => {},
    assertCurrent,
  });

async function setup(
  kind: "container" | "browser",
  running = true,
  prepareScope?: () => Promise<NodeJS.ProcessEnv>,
) {
  const browser = kind === "browser";
  const update = browser ? registry.updateBrowserRegistry : registry.updateRegistry;
  const remove = browser ? registry.removeBrowserRegistryEntry : registry.removeRegistryEntry;
  const read = browser ? registry.readBrowserRegistry : registry.readRegistry;
  await update(entry);
  const capturedBridge = bridge();
  if (browser) {
    BROWSER_BRIDGES.set(entry.sessionKey, capturedBridge);
  }
  const physical = new Set([oldId]);
  let named = oldId;
  const hooks = { afterRemove: async () => {} };
  const command = vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    const target = args.at(-1) === entry.containerName ? named : args.at(-1)!;
    if (args[0] === "inspect") {
      if (!physical.has(target)) {
        return { code: 1, stdout: "", stderr: "no such container" };
      }
      return success(
        args.includes("{{.Id}}")
          ? target
          : args.includes("{{.State.Paused}}")
            ? "false"
            : target + " " + running + " false",
      );
    }
    if (args[0] === "rm") {
      physical.delete(target);
      await hooks.afterRemove();
    }
    return success();
  });
  const authority = new AbortController();
  const selectedEnv = await prepareScope?.();
  const custody = await quiesce(() => authority.signal.throwIfAborted(), selectedEnv);
  const replacePhysical = () => {
    physical.delete(oldId);
    physical.add(newId);
    named = newId;
  };
  return {
    custody,
    physical,
    command,
    capturedBridge,
    rows: async () => (await read()).entries,
    removals: () =>
      command.mock.calls.filter(([, args]) => args[0] === "rm").map(([, args]) => args.at(-1)),
    replace: async () => {
      replacePhysical();
      await remove(entry.containerName);
      await update({ ...entry, createdAtMs: 2 });
    },
    replacePhysical,
    revoke: () => authority.abort(new Error("lease revoked")),
    hooks,
  };
}

it.each([
  ["container", "running"],
  ["container", "stopped"],
  ["container", "absent"],
  ["browser", "running"],
  ["browser", "stopped"],
  ["browser", "absent"],
] as const)("retires %s %s allocations without name fallback", async (kind, state) => {
  const h = await setup(kind, state === "running");
  let custody = h.custody;
  if (state === "absent") {
    h.physical.clear();
    custody = await quiesce();
    h.command.mockClear();
  }
  await custody.retire();
  await custody.resume();
  expect(h.physical.size).toBe(0);
  expect(h.removals()).toEqual(state === "absent" ? [] : [oldId]);
  expect(h.command.mock.calls.some(([, args]) => args[0] === "pause")).toBe(state === "running");
  expect(await h.rows()).toEqual([]);
  expect(BROWSER_BRIDGES.size).toBe(0);
});
it.each([
  ["container", "replacement"],
  ["browser", "replacement"],
  ["container", "revocation"],
  ["browser", "revocation"],
] as const)("preserves %s metadata after %s during removal", async (kind, change) => {
  const h = await setup(kind);
  h.hooks.afterRemove = change === "replacement" ? h.replace : async () => h.revoke();
  await expect(h.custody.retire()).rejects.toThrow(
    change === "replacement" ? /generation|owner changed/ : "lease revoked",
  );
  if (change === "replacement") {
    expect(h.physical.has(newId)).toBe(true);
    expect(await h.rows()).toMatchObject([{ createdAtMs: 2 }]);
  } else {
    expect(await h.rows()).toHaveLength(1);
  }
  expect(bridgeApi.stopBrowserBridgeServer).not.toHaveBeenCalled();
});
it.each(["before", "during", "rebound"] as const)(
  "does not chase a browser replacement at %s bridge shutdown",
  async (when) => {
    const h = await setup("browser");
    const replacement = bridge();
    const replace = async () => {
      if (when === "rebound") {
        h.replacePhysical();
      } else {
        BROWSER_BRIDGES.set(entry.sessionKey, replacement);
      }
    };
    if (when === "before") {
      await replace();
    } else {
      vi.mocked(bridgeApi.stopBrowserBridgeServer).mockImplementationOnce(replace);
    }
    if (when === "rebound") {
      await expect(h.custody.retire()).rejects.toThrow("custody retained");
    } else {
      await expect(h.custody.retire()).resolves.toBeUndefined();
    }
    expect(BROWSER_BRIDGES.get(entry.sessionKey)).toBe(
      when === "rebound" ? undefined : replacement,
    );
    expect(BROWSER_BRIDGES.size).toBe(when === "rebound" ? 0 : 1);
    expect(h.physical).toEqual(new Set(when === "rebound" ? [newId] : []));
    expect(vi.mocked(bridgeApi.stopBrowserBridgeServer).mock.calls).toEqual(
      when === "before" ? [] : [[h.capturedBridge.bridge.server]],
    );
    expect(await h.rows()).toEqual(when === "rebound" ? [expect.objectContaining(entry)] : []);
    expect(h.removals()).toEqual([oldId]);
  },
);

it.each(["container", "browser"] as const)(
  "retires %s registry custody in its captured database while preserving an identical ambient row",
  async (kind) => {
    const selectedEnv = { ...process.env };
    const ambientRoot = path.join(dirs.make("openclaw-retirement-ambient-"), "state");
    const h = await setup(kind, false, async () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);
      await (kind === "container"
        ? registry.updateRegistry(entry)
        : registry.updateBrowserRegistry(entry));
      return selectedEnv;
    });
    const read = kind === "container" ? registry.readRegistry : registry.readBrowserRegistry;
    const ambientEnv = { ...process.env };
    const ambientBefore = await read({ env: ambientEnv });
    expect((await read({ env: selectedEnv })).entries).toEqual([expect.objectContaining(entry)]);
    expect(ambientBefore.entries).toEqual([expect.objectContaining(entry)]);

    await h.custody.retire();

    expect(h.physical.size).toBe(0);
    expect(h.removals()).toEqual([oldId]);
    expect(await read({ env: ambientEnv })).toEqual(ambientBefore);
    expect((await read({ env: selectedEnv })).entries).toEqual([]);
  },
);
