import { statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../../src/test-helpers/temp-dir.js";
import { createFlowRecord, getFlowById, resetFlowRegistryForTests } from "./flow-registry.js";
import { resolveFlowRegistryDir, resolveFlowRegistrySqlitePath } from "./flow-registry.paths.js";
import { configureFlowRegistryRuntime } from "./flow-registry.store.js";
import type { FlowRecord } from "./flow-registry.types.js";

function createStoredFlow(): FlowRecord {
  return {
    flowId: "flow-restored",
    shape: "linear",
    ownerSessionKey: "agent:main:main",
    status: "blocked",
    notifyPolicy: "done_only",
    goal: "Restored flow",
    currentStep: "spawn_task",
    waitingOnTaskId: "task-waiting",
    outputs: {
      bucket: ["business"],
    },
    blockedTaskId: "task-restored",
    blockedSummary: "Writable session required.",
    createdAt: 100,
    updatedAt: 100,
    endedAt: 120,
  };
}

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-flow-store-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      // Close the sqlite-backed registry before Windows temp-dir cleanup removes the store root.
      resetFlowRegistryForTests();
    }
  });
}

describe("flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    resetFlowRegistryForTests();
  });

  it("uses the configured flow store for restore and save", () => {
    const storedFlow = createStoredFlow();
    const loadSnapshot = vi.fn(() => ({
      flows: new Map([[storedFlow.flowId, storedFlow]]),
    }));
    const saveSnapshot = vi.fn();
    configureFlowRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(getFlowById("flow-restored")).toMatchObject({
      flowId: "flow-restored",
      shape: "linear",
      goal: "Restored flow",
      waitingOnTaskId: "task-waiting",
      outputs: {
        bucket: ["business"],
      },
      blockedTaskId: "task-restored",
      blockedSummary: "Writable session required.",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createFlowRecord({
      ownerSessionKey: "agent:main:main",
      goal: "New flow",
      status: "running",
      currentStep: "wait_for",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      flows: ReadonlyMap<string, FlowRecord>;
    };
    expect(latestSnapshot.flows.size).toBe(2);
    expect(latestSnapshot.flows.get("flow-restored")?.goal).toBe("Restored flow");
  });

  it("restores persisted flows from the default sqlite store", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetFlowRegistryForTests();

      const created = createFlowRecord({
        ownerSessionKey: "agent:main:main",
        goal: "Persisted flow",
        status: "waiting",
        currentStep: "ask_user",
        waitingOnTaskId: "task-restored",
        outputs: {
          bucket: ["personal"],
        },
      });

      resetFlowRegistryForTests({ persist: false });

      expect(getFlowById(created.flowId)).toMatchObject({
        flowId: created.flowId,
        shape: "linear",
        status: "waiting",
        currentStep: "ask_user",
        waitingOnTaskId: "task-restored",
        outputs: {
          bucket: ["personal"],
        },
      });
    });
  });

  it("hardens the sqlite flow store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetFlowRegistryForTests();

      createFlowRecord({
        ownerSessionKey: "agent:main:main",
        goal: "Secured flow",
        status: "blocked",
        blockedTaskId: "task-secured",
        blockedSummary: "Need auth.",
      });

      const registryDir = resolveFlowRegistryDir(process.env);
      const sqlitePath = resolveFlowRegistrySqlitePath(process.env);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
    });
  });
});
