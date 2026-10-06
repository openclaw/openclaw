// Sandbox registry tests cover SQLite ordering and race safety for container/browser runtime records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";

const { TEST_STATE_DIR, PREVIOUS_OPENCLAW_STATE_DIR, SANDBOX_REGISTRY_PATH } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(nodePath.join(tmpdir(), "openclaw-sandbox-registry-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", baseDir);

  return {
    TEST_STATE_DIR: baseDir,
    PREVIOUS_OPENCLAW_STATE_DIR: previousStateDir,
    SANDBOX_REGISTRY_PATH: nodePath.join(baseDir, "containers.json"),
  };
});

import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  completeSandboxRegistryReservation,
  readBrowserRegistry,
  assertSandboxBrowserRegistryEntryCurrent,
  readRegisteredSandboxRuntimeIds,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime,
  reserveSandboxRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";
import { captureSandboxStateOwner } from "./state-owner.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(path.join(TEST_STATE_DIR, "state"), { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
});

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
  if (PREVIOUS_OPENCLAW_STATE_DIR === undefined) {
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
  } else {
    setTestEnvValue("OPENCLAW_STATE_DIR", PREVIOUS_OPENCLAW_STATE_DIR);
  }
});

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    containerName: "browser-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-browser:test",
    cdpPort: 9222,
    ...overrides,
  };
}

function containerEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "container-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-sandbox:test",
    ...overrides,
  };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    expect(code).toBe("ENOENT");
  }
}

describe("registry race safety", () => {
  it("keeps reservation and removal intent SQL off the caller thread", async () => {
    await updateRegistry(containerEntry({ containerName: "admission-fixture" }));
    const calls = observeMainThreadSql();
    calls.calibrate();
    const removeRuntime = vi.fn(async () => {});
    try {
      const reserved = await reserveSandboxRegistryEntry(
        containerEntry({
          containerName: "reserved-boundary",
          backendId: "boundary",
          sessionKey: "agent:boundary",
          workspaceDir: "/synthetic/workspace",
        }),
      );
      expect(reserved).toMatchObject({
        containerName: "reserved-boundary",
        runtimeState: "pending",
      });
      await removeSandboxRegistryRuntime(reserved, removeRuntime);
      expect(removeRuntime).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          containerName: "reserved-boundary",
          runtimeState: "removing-pending",
        }),
      );
      await expect(readRegistryEntry(reserved.containerName)).resolves.toBeNull();
      calls.expectIdle();
    } finally {
      calls.restore();
    }
  });

  it("preserves a runtime whose activity advanced after the prune scan", async () => {
    const entry = await reserveSandboxRegistryEntry(
      containerEntry({ backendId: "prune-boundary", workspaceDir: "/synthetic/workspace" }),
    );
    const now = 2 * 60 * 60 * 1000;
    await updateRegistry({ ...entry, lastUsedAtMs: now });
    const removeRuntime = vi.fn(async () => {});
    await removeSandboxRegistryRuntime(entry, removeRuntime, {
      prune: { now, idleHours: 1, maxAgeDays: 0 },
    });
    expect(removeRuntime).not.toHaveBeenCalled();
    await expect(readRegistryEntry(entry.containerName)).resolves.toMatchObject({
      lastUsedAtMs: now,
      runtimeState: "pending",
    });
  });

  it("settles accepted removal across direct database close", async ({ signal }) => {
    const entry = await reserveSandboxRegistryEntry(
      containerEntry({ backendId: "close-boundary", workspaceDir: "/synthetic/workspace" }),
    );
    const providerEntered = createDeferred();
    const releaseProvider = createDeferred();
    const removeRuntime = vi.fn(async () => {
      providerEntered.resolve();
      await releaseProvider.promise;
    });
    const removing = removeSandboxRegistryRuntime(entry, removeRuntime);
    let closing: Promise<void> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          providerEntered.promise,
          removing,
          "Removal settled before its provider accepted cleanup",
        ),
        signal,
      );
      closing = closeOpenClawStateDatabaseAsync();
      releaseProvider.resolve();
      await withinTest(Promise.all([removing, closing]), signal);
      expect(removeRuntime).toHaveBeenCalledOnce();
      await expect(readRegistryEntry(entry.containerName)).resolves.toBeNull();
    } finally {
      releaseProvider.resolve();
      await Promise.allSettled([removing, closing]);
    }
  });

  it("refuses queued browser publication after hosted custody is released", async () => {
    const owner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(TEST_STATE_DIR, "openclaw.json"),
        role: "gateway",
      },
    });
    try {
      await updateRegistry(containerEntry());
      const assertCurrent = await captureSandboxStateOwner();
      const publication = updateBrowserRegistry(browserEntry(), assertCurrent);
      owner.release();
      await expect(publication).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      await expect(readBrowserRegistry()).resolves.toEqual({ entries: [] });
    } finally {
      owner.release();
    }
  });

  it("settles browser activity in workers while preserving captured fields and workspace custody", async () => {
    // Admit the schema before observing the runtime write boundary.
    await updateRegistry(containerEntry());
    const hostSql = vi.spyOn(sqliteQueries, "executeSqliteQuerySync").mockImplementation(() => {
      throw new Error("Browser registry writes must not execute SQL on the host");
    });
    try {
      const entry = browserEntry({ workspaceDir: "/original/workspace", cdpPort: 0 });
      const reservation = updateBrowserRegistry(entry);
      entry.image = "changed-after-dispatch";
      entry.workspaceDir = "/changed-after-dispatch";
      await reservation;
      await updateBrowserRegistry(
        browserEntry({ createdAtMs: 99, lastUsedAtMs: 2, image: "ignored" }),
      );
      await expect(readBrowserRegistry()).resolves.toEqual({
        entries: [browserEntry({ workspaceDir: "/original/workspace", lastUsedAtMs: 2 })],
      });
    } finally {
      hostSql.mockRestore();
    }
    const [selected] = (await readBrowserRegistry()).entries;
    expect(selected?.workspaceDir).toBe("/original/workspace");
    expect(() => assertSandboxBrowserRegistryEntryCurrent(selected!)).not.toThrow();
    await updateBrowserRegistry(browserEntry({ workspaceDir: "/other/workspace" }));
    expect(() => assertSandboxBrowserRegistryEntryCurrent(selected!)).toThrow("owner changed");
  });

  it("does not migrate legacy registry files from runtime reads", async () => {
    // Runtime reads should ignore old monolithic files; explicit doctor/repair
    // owns migration so normal startup cannot mutate registry layout.
    const legacyEntry = containerEntry({ containerName: "legacy-container" });
    await fs.writeFile(
      SANDBOX_REGISTRY_PATH,
      `${JSON.stringify({ entries: [legacyEntry] }, null, 2)}\n`,
      "utf-8",
    );

    await expect(readRegistry()).resolves.toEqual({ entries: [] });
    await expect(readRegistryEntry("legacy-container")).resolves.toBeNull();
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).resolves.toBeUndefined();
    await expectPathMissing(path.join(TEST_STATE_DIR, "state", "openclaw.sqlite"));
  });

  it("captures a Podman target and preserves immutable fields across usage updates", async () => {
    const target = {
      key: "machine:target-a",
      globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
    };
    const entry = containerEntry({
      backendId: "podman",
      backendTarget: target,
      createdAtMs: 11,
      workspaceDir: "/original/workspace",
    });
    const initialWrite = updateRegistry(entry);
    target.globalArgs[1] = "ssh://changed-after-dispatch/run/podman/podman.sock";
    entry.createdAtMs = 99;
    entry.image = "changed-after-dispatch";
    entry.workspaceDir = "/changed-after-dispatch";
    await initialWrite;
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        lastUsedAtMs: 2,
        workspaceDir: "/later/workspace",
      }),
    );

    await expect(readRegistryEntry("container-a")).resolves.toMatchObject({
      backendId: "podman",
      backendTarget: {
        key: "machine:target-a",
        globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
      },
      lastUsedAtMs: 2,
      createdAtMs: 11,
      image: "openclaw-sandbox:test",
      workspaceDir: "/original/workspace",
    });
  });

  it("settles runtime registry writes in the worker and retains pending completion rules", async () => {
    const entry = containerEntry({
      backendId: "docker",
      runtimeState: "pending",
      workspaceDir: "/original/workspace",
    });
    await updateRegistry(entry);
    const hostSql = vi.spyOn(sqliteQueries, "executeSqliteQuerySync").mockImplementation(() => {
      throw new Error("Sandbox registry writes must not execute SQL on the host");
    });
    try {
      await updateRegistry({ ...entry, lastUsedAtMs: 2, createdAtMs: 99, image: "ignored-update" });
      await completeSandboxRegistryReservation({
        ...entry,
        lastUsedAtMs: 3,
        image: "initialized-image",
      });
      await completeSandboxRegistryReservation({
        ...entry,
        lastUsedAtMs: 4,
        image: "ignored-ready",
      });
      await expect(readRegistryEntry(entry.containerName)).resolves.toMatchObject({
        runtimeState: "ready",
        createdAtMs: 1,
        lastUsedAtMs: 4,
        image: "initialized-image",
        workspaceDir: "/original/workspace",
      });
      await completeSandboxRegistryReservation(entry, true);
      await expect(readRegistryEntry(entry.containerName)).resolves.toBeNull();
      await updateRegistry({ ...entry, containerName: "direct-remove" });
      await removeRegistryEntry("direct-remove", { preserveRemovalIntent: true });
      await expect(readRegistryEntry("direct-remove")).resolves.toBeNull();
    } finally {
      hostSql.mockRestore();
    }
  });

  it("refuses pending publication, completion or retirement after removal intent", async () => {
    for (const state of ["missing", "removing", "removing-pending"] as const) {
      const entry = containerEntry({ containerName: state, backendId: "docker" });
      if (state !== "missing") {
        await updateRegistry({ ...entry, runtimeState: state });
      }
      const before = await readRegistryEntry(entry.containerName);
      if (state !== "missing") {
        await expect(updateRegistry({ ...entry, runtimeState: "pending" })).rejects.toThrow(
          "Sandbox runtime was removed or is being removed",
        );
      }
      for (const retired of [false, true]) {
        await expect(completeSandboxRegistryReservation(entry, retired)).rejects.toThrow(
          "Sandbox runtime was removed or is being removed",
        );
      }
      await expect(readRegistryEntry(entry.containerName)).resolves.toEqual(before);
      await removeRegistryEntry(entry.containerName, { preserveRemovalIntent: true });
      await expect(readRegistryEntry(entry.containerName)).resolves.toEqual(before);
      await removeRegistryEntry(entry.containerName);
      await expect(readRegistryEntry(entry.containerName)).resolves.toBeNull();
    }
  });

  it("reads registered runtime IDs for one backend and scope newest first", async () => {
    for (const [containerName, backendId, sessionKey, lastUsedAtMs] of [
      ["openshell-older", "openshell", "agent:main", 10],
      ["openshell-newer", "openshell", "agent:main", 20],
      ["docker-same-scope", "docker", "agent:main", 30],
      ["openshell-other-scope", "openshell", "agent:other", 40],
    ] as const) {
      await updateRegistry(containerEntry({ containerName, backendId, sessionKey, lastUsedAtMs }));
    }

    await expect(
      readRegisteredSandboxRuntimeIds({
        backendId: "openshell",
        scopeKey: "agent:main",
      }),
    ).resolves.toEqual(["openshell-newer", "openshell-older"]);
  });

  it("stores unsafe container names without writing path-derived files", async () => {
    await updateRegistry(containerEntry({ containerName: "../escape" }));

    const registry = await readRegistry();

    expect(registry.entries.map((entry) => entry.containerName)).toEqual(["../escape"]);
    await expectPathMissing(`${TEST_STATE_DIR}/escape.json`);
  });

  it.each(["container", "browser"] as const)(
    "keeps concurrent %s updates in deterministic name order",
    async (kind) => {
      await Promise.all(
        ["c", "a", "b"].map((name, index) => {
          const containerName = `${kind}-${name}`;
          return kind === "container"
            ? updateRegistry(containerEntry({ containerName }))
            : updateBrowserRegistry(browserEntry({ containerName, cdpPort: 9222 + index }));
        }),
      );
      const registry = await (kind === "container" ? readRegistry() : readBrowserRegistry());
      expect(registry.entries.map((entry) => entry.containerName)).toEqual(
        ["a", "b", "c"].map((name) => `${kind}-${name}`),
      );
    },
  );

  it.each(["container", "name", "generation"] as const)(
    "prevents a queued update from overtaking %s removal",
    async (removal) => {
      if (removal === "container") {
        await updateRegistry(containerEntry({ containerName: "container-x" }));
        await Promise.all([
          updateRegistry(containerEntry({ containerName: "container-x", configHash: "updated" })),
          removeRegistryEntry("container-x"),
        ]);
        expect((await readRegistry()).entries).toHaveLength(0);
        return;
      }
      const entry = browserEntry({ containerName: "browser-x" });
      await updateBrowserRegistry(entry);
      await updateRegistry(containerEntry({ containerName: "browser-x" }));
      // Neither call is awaited: removal must follow the already accepted activity write.
      const updatePromise = updateBrowserRegistry({ ...entry, lastUsedAtMs: 2 });
      const removePromise =
        removal === "name"
          ? removeBrowserRegistryEntry("browser-x")
          : removeSandboxRegistryGeneration("browser", entry, () => {});
      await Promise.all([updatePromise, removePromise]);

      const registry = await readBrowserRegistry();
      expect(registry.entries).toHaveLength(0);
      await expect(readRegistryEntry("browser-x")).resolves.toMatchObject({
        containerName: "browser-x",
      });
    },
  );
});
