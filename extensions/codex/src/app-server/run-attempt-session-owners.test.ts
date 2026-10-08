import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OwnerProjection = {
  stateDir: string | undefined;
  storePath: string;
  sessionKey: string;
  expectedSessionId?: string;
};

const fixture = vi.hoisted(() => ({
  steps: [] as string[],
  deleted: [] as OwnerProjection[],
  drainMaintenance: async () => {},
  drainAgents: async () => {},
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: () => `${process.env.OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json`,
  patchSessionEntry: async () => {},
  deleteSessionEntry: async (scope: {
    env?: NodeJS.ProcessEnv;
    storePath: string;
    sessionKey: string;
    expectedSessionId?: string;
  }) => {
    fixture.steps.push("delete");
    fixture.deleted.push({
      stateDir: scope.env?.OPENCLAW_STATE_DIR,
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
      expectedSessionId: scope.expectedSessionId,
    });
  },
}));

vi.mock("openclaw/plugin-sdk/sqlite-runtime-testing", () => ({
  withSessionHistoryBudgetSweepsForTest: async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } finally {
      fixture.steps.push("maintenance-drain");
      await fixture.drainMaintenance();
    }
  },
  closeOpenClawAgentDatabasesAsync: async () => {
    fixture.steps.push("agent-drain");
    await fixture.drainAgents();
  },
  closeOpenClawAgentDatabasesForTest: () => {
    fixture.steps.push("agent-reset");
  },
  closeOpenClawStateDatabaseAsync: async () => {
    fixture.steps.push("shared-drain");
  },
}));

vi.mock("openclaw/plugin-sdk/plugin-state-test-runtime", () => ({
  resetPluginStateStoreForTests: (options?: { closeDatabase?: boolean }) => {
    fixture.steps.push(options?.closeDatabase === false ? "plugin-policy-reset" : "plugin-reset");
  },
}));

beforeEach(() => {
  vi.resetModules();
  fixture.steps.length = 0;
  fixture.deleted.length = 0;
  fixture.drainMaintenance = async () => {};
  fixture.drainAgents = async () => {};
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/original-state");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function expectedOwner(sessionId: string): OwnerProjection {
  return {
    stateDir: "/synthetic/original-state",
    storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
    sessionKey: `agent:main:${sessionId}`,
    expectedSessionId: sessionId,
  };
}

describe("run attempt seeded session ownership", () => {
  it("retains a seeded row when its background maintenance fails", async () => {
    const { seedRunSessionOwnerForTest, cleanupRunSessionOwnersForTest } =
      await import("./run-attempt-session-owners.test-support.js");
    const failure = new Error("synthetic maintenance failed");
    fixture.drainMaintenance = async () => {
      throw failure;
    };
    await expect(
      seedRunSessionOwnerForTest("retained-session", "agent:main:retained-session"),
    ).rejects.toBe(failure);
    fixture.drainMaintenance = async () => {};
    await cleanupRunSessionOwnersForTest();
    expect(fixture.deleted).toEqual([expectedOwner("retained-session")]);
  });

  it("retains the original seeded owner when an agent drain fails", async () => {
    const { seedRunSessionOwnerForTest, cleanupRunSessionOwnersForTest } =
      await import("./run-attempt-session-owners.test-support.js");
    await seedRunSessionOwnerForTest("retained-session", "agent:main:retained-session");
    fixture.steps.length = 0;
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/rebound-state");
    const failure = new Error("synthetic agent drain failed");
    fixture.drainAgents = async () => {
      throw failure;
    };
    await expect(cleanupRunSessionOwnersForTest({ closeDatabases: true })).rejects.toBe(failure);
    expect(fixture.steps).toEqual(["delete", "maintenance-drain", "agent-drain"]);

    fixture.steps.length = 0;
    fixture.drainAgents = async () => {};
    await cleanupRunSessionOwnersForTest({ closeDatabases: true });
    expect(fixture.deleted).toEqual([
      expectedOwner("retained-session"),
      expectedOwner("retained-session"),
    ]);
    expect(fixture.steps).toEqual([
      "delete",
      "maintenance-drain",
      "agent-drain",
      "agent-reset",
      "shared-drain",
      "plugin-reset",
    ]);
    await cleanupRunSessionOwnersForTest();
    expect(fixture.deleted).toHaveLength(2);
  });
});
