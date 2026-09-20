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
  resetPluginStateStoreForTests: () => {
    fixture.steps.push("plugin-reset");
  },
}));

beforeEach(() => {
  vi.resetModules();
  fixture.steps.length = 0;
  fixture.seeded.length = 0;
  fixture.deleted.length = 0;
  fixture.deleteRow = async () => {};
  fixture.drainAgents = async () => {};
  fixture.drainShared = async () => {};
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/original-state");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("run attempt seeded session ownership", () => {
  it("keeps original selectors and awaits deletion and drains before resetting state", async () => {
    const { seedRunSessionOwnerForTest, cleanupRunSessionOwnersForTest } =
      await import("./run-attempt-session-owners.test-support.js");
    await seedRunSessionOwnerForTest("seeded-session", "agent:main:seeded-session");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/rebound-state");

    const deletion = createDeferred<void>();
    const deleting = createDeferred<void>();
    const agents = createDeferred<void>();
    const drainingAgents = createDeferred<void>();
    const shared = createDeferred<void>();
    const drainingShared = createDeferred<void>();
    fixture.deleteRow = () => {
      deleting.resolve();
      return deletion.promise;
    };
    fixture.drainAgents = () => {
      drainingAgents.resolve();
      return agents.promise;
    };
    fixture.drainShared = () => {
      drainingShared.resolve();
      return shared.promise;
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
      await drainingAgents.promise;
      expect(fixture.steps).toEqual(["delete", "agent-drain"]);

      agents.resolve();
      await drainingShared.promise;
      expect(fixture.steps).toEqual(["delete", "agent-drain", "agent-reset", "shared-drain"]);

      shared.resolve();
      await cleanup;
      expect(fixture.steps).toEqual([
        "delete",
        "agent-drain",
        "agent-reset",
        "shared-drain",
        "plugin-reset",
      ]);
    } finally {
      deletion.resolve();
      agents.resolve();
      shared.resolve();
      await cleanup;
    }
  });

  it("retains the original seeded owner when an agent drain fails", async () => {
    const { seedRunSessionOwnerForTest, cleanupRunSessionOwnersForTest } =
      await import("./run-attempt-session-owners.test-support.js");
    await seedRunSessionOwnerForTest("retained-session", "agent:main:retained-session");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/rebound-state");
    const failure = new Error("synthetic agent drain failed");
    fixture.drainAgents = async () => {
      throw failure;
    };

    await expect(cleanupRunSessionOwnersForTest()).rejects.toBe(failure);
    expect(fixture.steps).toEqual(["delete", "agent-drain"]);

    fixture.steps.length = 0;
    fixture.drainAgents = async () => {};
    await cleanupRunSessionOwnersForTest();
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
    expect(fixture.steps).toEqual([
      "delete",
      "agent-drain",
      "agent-reset",
      "shared-drain",
      "plugin-reset",
    ]);
    await cleanupRunSessionOwnersForTest();
    expect(fixture.deleted).toHaveLength(2);
  });
});
