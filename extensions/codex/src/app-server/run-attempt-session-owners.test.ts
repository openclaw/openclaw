import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OwnerProjection = {
  stateDir: string | undefined;
  storePath: string;
  sessionKey: string;
  expectedSessionId?: string;
};

const fixture = vi.hoisted(() => ({
  steps: [] as string[],
  seeded: [] as OwnerProjection[],
  deleted: [] as OwnerProjection[],
  deleteRow: async () => {},
  drainMaintenance: async () => {},
  drainAgents: async () => {},
  drainShared: async () => {},
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: () => `${process.env.OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json`,
  upsertSessionEntry: async (scope: {
    env?: NodeJS.ProcessEnv;
    storePath: string;
    sessionKey: string;
  }) => {
    fixture.seeded.push({
      stateDir: scope.env?.OPENCLAW_STATE_DIR,
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
    });
  },
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
    await fixture.deleteRow();
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
    await fixture.drainShared();
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
  fixture.seeded.length = 0;
  fixture.deleted.length = 0;
  fixture.deleteRow = async () => {};
  fixture.drainMaintenance = async () => {};
  fixture.drainAgents = async () => {};
  fixture.drainShared = async () => {};
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/original-state");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    expect(fixture.deleted).toEqual([
      {
        stateDir: "/synthetic/original-state",
        storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
        sessionKey: "agent:main:retained-session",
        expectedSessionId: "retained-session",
      },
    ]);
  });

  it("deletes captured session rows before resetting policy without closing suite databases", async () => {
    const { seedRunSessionOwnerForTest, cleanupRunSessionOwnersForTest } =
      await import("./run-attempt-session-owners.test-support.js");
    await seedRunSessionOwnerForTest("seeded-session", "agent:main:seeded-session");
    fixture.steps.length = 0;
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/rebound-state");

    const deletion = createDeferred<void>();
    const deleting = createDeferred<void>();
    const maintenance = createDeferred<void>();
    const drainingMaintenance = createDeferred<void>();
    fixture.deleteRow = () => {
      deleting.resolve();
      return deletion.promise;
    };
    fixture.drainMaintenance = () => {
      drainingMaintenance.resolve();
      return maintenance.promise;
    };

    const cleanup = cleanupRunSessionOwnersForTest();
    try {
      await deleting.promise;
      expect(fixture.steps).toEqual(["delete"]);
      expect(fixture.seeded).toEqual([
        {
          stateDir: "/synthetic/original-state",
          storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
          sessionKey: "agent:main:seeded-session",
        },
      ]);
      expect(fixture.deleted).toEqual([
        {
          stateDir: "/synthetic/original-state",
          storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
          sessionKey: "agent:main:seeded-session",
          expectedSessionId: "seeded-session",
        },
      ]);

      deletion.resolve();
      await drainingMaintenance.promise;
      expect(fixture.steps).toEqual(["delete", "maintenance-drain"]);
      maintenance.resolve();
      await cleanup;
      expect(fixture.steps).toEqual(["delete", "maintenance-drain", "plugin-policy-reset"]);
    } finally {
      deletion.resolve();
      maintenance.resolve();
      await cleanup;
    }
  });

  it.each(["deletion", "agent drain"] as const)(
    "retains the original seeded owner when %s fails",
    async (failureStage) => {
      const { seedRunSessionOwnerForTest, cleanupRunSessionOwnersForTest } =
        await import("./run-attempt-session-owners.test-support.js");
      await seedRunSessionOwnerForTest("retained-session", "agent:main:retained-session");
      fixture.steps.length = 0;
      vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/rebound-state");
      const failure = new Error(`synthetic ${failureStage} failed`);
      const closeDatabases = failureStage === "agent drain";
      fixture[closeDatabases ? "drainAgents" : "deleteRow"] = async () => {
        throw failure;
      };

      await expect(cleanupRunSessionOwnersForTest({ closeDatabases })).rejects.toBe(failure);
      expect(fixture.steps).toEqual(
        closeDatabases
          ? ["delete", "maintenance-drain", "agent-drain"]
          : ["delete", "maintenance-drain"],
      );

      fixture.steps.length = 0;
      fixture.deleteRow = async () => {};
      fixture.drainAgents = async () => {};
      await cleanupRunSessionOwnersForTest({ closeDatabases });
      expect(fixture.deleted).toEqual([
        {
          stateDir: "/synthetic/original-state",
          storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
          sessionKey: "agent:main:retained-session",
          expectedSessionId: "retained-session",
        },
        {
          stateDir: "/synthetic/original-state",
          storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
          sessionKey: "agent:main:retained-session",
          expectedSessionId: "retained-session",
        },
      ]);
      expect(fixture.steps).toEqual(
        closeDatabases
          ? [
              "delete",
              "maintenance-drain",
              "agent-drain",
              "agent-reset",
              "shared-drain",
              "plugin-reset",
            ]
          : ["delete", "maintenance-drain", "plugin-policy-reset"],
      );
      await cleanupRunSessionOwnersForTest();
      expect(fixture.deleted).toHaveLength(2);
    },
  );

  it.each(["suite", "unsettled attempt"] as const)(
    "joins %s database workers before resetting their native state",
    async (lifetime) => {
      const { cleanupRunSessionOwnersForTest, closeRunSessionOwnerDatabasesForTest } =
        await import("./run-attempt-session-owners.test-support.js");
      const agents = createDeferred<void>();
      const drainingAgents = createDeferred<void>();
      const shared = createDeferred<void>();
      const drainingShared = createDeferred<void>();
      fixture.drainAgents = () => {
        drainingAgents.resolve();
        return agents.promise;
      };
      fixture.drainShared = () => {
        drainingShared.resolve();
        return shared.promise;
      };

      const close =
        lifetime === "suite"
          ? closeRunSessionOwnerDatabasesForTest()
          : cleanupRunSessionOwnersForTest({ closeDatabases: true });
      try {
        await Promise.race([drainingAgents.promise, close]);
        const maintenanceSteps = lifetime === "suite" ? [] : ["maintenance-drain"];
        expect(fixture.steps).toEqual([...maintenanceSteps, "agent-drain"]);
        agents.resolve();
        await Promise.race([drainingShared.promise, close]);
        expect(fixture.steps).toEqual([
          ...maintenanceSteps,
          "agent-drain",
          "agent-reset",
          "shared-drain",
        ]);
        shared.resolve();
        await close;
        expect(fixture.steps).toEqual([
          ...maintenanceSteps,
          "agent-drain",
          "agent-reset",
          "shared-drain",
          "plugin-reset",
        ]);
      } finally {
        agents.resolve();
        shared.resolve();
        await close;
      }
    },
  );

  it("does not reset suite state when an agent drain fails", async () => {
    const { closeRunSessionOwnerDatabasesForTest } =
      await import("./run-attempt-session-owners.test-support.js");
    const failure = new Error("synthetic agent drain failed");
    fixture.drainAgents = async () => {
      throw failure;
    };
    await expect(closeRunSessionOwnerDatabasesForTest()).rejects.toBe(failure);
    expect(fixture.steps).toEqual(["agent-drain"]);

    fixture.steps.length = 0;
    fixture.drainAgents = async () => {};
    await closeRunSessionOwnerDatabasesForTest();
    expect(fixture.steps).toEqual(["agent-drain", "agent-reset", "shared-drain", "plugin-reset"]);
  });
});
