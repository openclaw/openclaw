import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.js";
import * as registryModule from "./subagent-registry.js";
import {
  loadSubagentRegistryFromDisk,
  resolveSubagentRegistryPath,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(async () => ({
    status: "ok",
    startedAt: 111,
    endedAt: 222,
  })),
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

const { onAgentEventMock } = vi.hoisted(() => ({
  onAgentEventMock: vi.fn(() => () => {}),
}));
vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: onAgentEventMock,
}));

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (...args: unknown[]) => announceSpy(...args),
}));

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({
    agents: {
      defaults: {
        subagents: {
          archiveAfterMinutes: 0,
        },
      },
    },
  })),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

const { registerSubagentRun, resetSubagentRegistryForTests, addSubagentRunForTests } =
  registryModule;

type RegistryModule = typeof registryModule & {
  getRunByChildKey: (key: string) => SubagentRunRecord | undefined;
  getActiveChildCount: (key: string) => number;
  listAllSubagentRuns: () => SubagentRunRecord[];
  reserveChildSlot: (parentKey: string, max: number) => boolean;
  releaseChildSlot: (parentKey: string) => void;
};

const extendedRegistry = registryModule as unknown as RegistryModule;
const {
  getRunByChildKey,
  getActiveChildCount,
  listAllSubagentRuns,
  reserveChildSlot,
  releaseChildSlot,
} = extendedRegistry;

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tempStateDir: string | null = null;

beforeEach(async () => {
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-depth-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(async () => {
  resetSubagentRegistryForTests({ persist: false });
  callGatewayMock.mockClear();
  onAgentEventMock.mockClear();
  announceSpy.mockClear();
  loadConfigMock.mockClear();
  if (tempStateDir) {
    await fs.rm(tempStateDir, { recursive: true, force: true });
    tempStateDir = null;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

async function waitForPerformanceRecord(
  runId: string,
  stateDir: string,
): Promise<Record<string, unknown>> {
  const dataDir = path.join(stateDir, "data");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const files = await fs.readdir(dataDir);
      for (const file of files) {
        if (!file.startsWith("agent-performance-") || !file.endsWith(".jsonl")) {
          continue;
        }
        const raw = await fs.readFile(path.join(dataDir, file), "utf8");
        const lines = raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const record = lines.find((line) => line.runId === runId);
        if (record) {
          return record;
        }
      }
    } catch {
      // File may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for performance record for run ${runId}`);
}

describe("subagent registry depth metadata", () => {
  it("stores explicit depth and initializes childKeys", () => {
    registerSubagentRun({
      runId: "run-depth-1",
      childSessionKey: "agent:main:subagent:child-depth",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do work",
      cleanup: "keep",
      depth: 3,
    });

    const record = getRunByChildKey?.("agent:main:subagent:child-depth");
    expect(record?.depth).toBe(3);
    expect(record?.childKeys).toBeDefined();
    expect(Array.from(record?.childKeys ?? [])).toEqual([]);
  });

  it("defaults depth to 1 when not provided", () => {
    registerSubagentRun({
      runId: "run-depth-default",
      childSessionKey: "agent:main:subagent:child-default",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "default depth",
      cleanup: "keep",
    });

    const record = getRunByChildKey?.("agent:main:subagent:child-default");
    expect(record?.depth).toBe(1);
  });

  it("updates parent childKeys when registering children", () => {
    const parentRun: SubagentRunRecord = {
      runId: "parent-run",
      childSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "root",
      task: "parent",
      cleanup: "keep",
      createdAt: Date.now(),
    } as SubagentRunRecord;
    addSubagentRunForTests(parentRun);

    registerSubagentRun({
      runId: "child-run",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "child task",
      cleanup: "keep",
      depth: 2,
    });

    const parent = getRunByChildKey?.("agent:main:subagent:parent");
    expect(parent).toBeTruthy();
    const childKeys = parent?.childKeys ?? new Set();
    expect(childKeys instanceof Set).toBe(true);
    expect(Array.from(childKeys)).toContain("agent:main:subagent:child");
  });

  it("getActiveChildCount counts only unfinished runs", () => {
    const parentKey = "agent:main:main";
    addSubagentRunForTests({
      runId: "active-1",
      childSessionKey: "agent:main:subagent:active-1",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "root",
      task: "active",
      cleanup: "keep",
      createdAt: Date.now(),
    } as SubagentRunRecord);
    addSubagentRunForTests({
      runId: "completed-1",
      childSessionKey: "agent:main:subagent:done",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "root",
      task: "done",
      cleanup: "keep",
      createdAt: Date.now(),
      endedAt: Date.now(),
    } as SubagentRunRecord);

    expect(getActiveChildCount?.(parentKey)).toBe(1);
  });

  it("listAllSubagentRuns returns snapshot of all runs", () => {
    registerSubagentRun({
      runId: "run-a",
      childSessionKey: "agent:main:subagent:a",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "root",
      task: "A",
      cleanup: "keep",
    });
    registerSubagentRun({
      runId: "run-b",
      childSessionKey: "agent:main:subagent:b",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "root",
      task: "B",
      cleanup: "keep",
    });

    const snapshot = listAllSubagentRuns?.() ?? [];
    expect(snapshot.map((run) => run.runId).toSorted()).toEqual(["run-a", "run-b"]);
    snapshot.pop();
    const nextSnapshot = listAllSubagentRuns?.() ?? [];
    expect(nextSnapshot).toHaveLength(2);
  });
});

describe("registry persistence", () => {
  it("serializes childKeys as arrays and restores Sets", async () => {
    const map = new Map<string, SubagentRunRecord>();
    map.set("persist-run", {
      runId: "persist-run",
      childSessionKey: "agent:main:subagent:persist",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "root",
      task: "persist",
      cleanup: "keep",
      createdAt: 1,
      depth: 2,
      childKeys: new Set(["agent:main:subagent:c1", "agent:main:subagent:c2"]),
    } as unknown as SubagentRunRecord);

    saveSubagentRegistryToDisk(map);

    const registryPath = resolveSubagentRegistryPath();
    const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      version: number;
      runs: Record<string, { childKeys?: string[] }>;
    };
    expect(raw.version).toBe(3);
    expect(raw.runs["persist-run"].childKeys).toEqual([
      "agent:main:subagent:c1",
      "agent:main:subagent:c2",
    ]);

    const loaded = loadSubagentRegistryFromDisk();
    const restored = loaded.get("persist-run");
    expect(restored?.childKeys).toBeDefined();
    expect(Array.from(restored?.childKeys ?? [])).toEqual([
      "agent:main:subagent:c1",
      "agent:main:subagent:c2",
    ]);
    expect(restored?.depth).toBe(2);
  });

  it("loads legacy records with default childKeys and depth", async () => {
    const registryPath = resolveSubagentRegistryPath();
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({
        version: 2,
        runs: {
          "legacy-run": {
            runId: "legacy-run",
            childSessionKey: "agent:main:subagent:legacy",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "root",
            task: "legacy",
            cleanup: "keep",
            createdAt: 1,
          },
        },
      })}\n`,
      "utf8",
    );

    const loaded = loadSubagentRegistryFromDisk();
    const legacy = loaded.get("legacy-run");
    expect(legacy?.depth).toBeUndefined();
    expect(legacy?.childKeys).toBeDefined();
    expect(Array.from(legacy?.childKeys ?? [])).toEqual([]);
  });
});

describe("slot reservation", () => {
  it("reserves and releases slots synchronously", () => {
    const parentKey = "agent:main:main";
    expect(reserveChildSlot?.(parentKey, 1)).toBe(true);
    expect(reserveChildSlot?.(parentKey, 1)).toBe(false);
    releaseChildSlot?.(parentKey);
    expect(reserveChildSlot?.(parentKey, 1)).toBe(true);
  });

  it("consumes pending slot when registering run", () => {
    const parentKey = "agent:main:main";
    expect(reserveChildSlot?.(parentKey, 2)).toBe(true);

    registerSubagentRun({
      runId: "reserved-child",
      childSessionKey: "agent:main:subagent:reserved",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "root",
      task: "child",
      cleanup: "keep",
    });

    expect(getActiveChildCount?.(parentKey)).toBe(1);
    expect(reserveChildSlot?.(parentKey, 2)).toBe(true);
  });

  it("clears pending reservations on reset", () => {
    const parentKey = "agent:main:main";
    expect(reserveChildSlot?.(parentKey, 1)).toBe(true);
    resetSubagentRegistryForTests({ persist: false });
    expect(reserveChildSlot?.(parentKey, 1)).toBe(true);
  });
});

describe("performance tracking", () => {
  it("records performance JSONL after subagent announce + cleanup", async () => {
    if (!tempStateDir) {
      throw new Error("missing tempStateDir");
    }

    registerSubagentRun({
      runId: "run-performance-jsonl",
      childSessionKey: "agent:main:subagent:perf",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "collect stats",
      cleanup: "keep",
    });

    const record = await waitForPerformanceRecord("run-performance-jsonl", tempStateDir);
    expect(record).toMatchObject({
      runId: "run-performance-jsonl",
      agentId: "main",
      spawnerSessionKey: "agent:main:main",
    });
  });
});
