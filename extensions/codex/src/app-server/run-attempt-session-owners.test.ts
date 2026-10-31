import { afterEach, beforeEach, expect, it, vi } from "vitest";

type DeleteScope = Parameters<
  typeof import("openclaw/plugin-sdk/session-store-runtime").deleteSessionEntry
>[0];

const fixture = vi.hoisted(() => ({
  steps: [] as string[],
  deleted: [] as DeleteScope[],
  drainMaintenance: vi.fn(async () => {}),
  drainAgents: vi.fn(async () => {}),
}));

// mock-isolation: Record session ownership without opening real session stores.
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: () => `${process.env.OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json`,
  patchSessionEntry: async () => {},
  deleteSessionEntry: async (scope: DeleteScope) => {
    fixture.steps.push("delete");
    fixture.deleted.push(scope);
  },
}));

// mock-isolation: Control database drain failures and ordering without live database owners.
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
  closeOpenClawAgentDatabasesForTest: () => fixture.steps.push("agent-reset"),
  closeOpenClawStateDatabaseAsync: async () => fixture.steps.push("shared-drain"),
}));

vi.mock("openclaw/plugin-sdk/plugin-state-test-runtime", () => ({
  resetPluginStateStoreForTests: (options?: { closeDatabase?: boolean }) => {
    fixture.steps.push(options?.closeDatabase === false ? "plugin-policy-reset" : "plugin-reset");
  },
}));

let owners: typeof import("./run-attempt-session-owners.test-support.js");
beforeEach(async () => {
  vi.resetModules();
  fixture.steps.length = fixture.deleted.length = 0;
  fixture.drainMaintenance.mockReset();
  fixture.drainAgents.mockReset();
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/original-state");
  owners = await import("./run-attempt-session-owners.test-support.js");
});

afterEach(() => vi.unstubAllEnvs());

const expectedOwner = {
  env: { OPENCLAW_STATE_DIR: "/synthetic/original-state" },
  storePath: "/synthetic/original-state/agents/main/sessions/sessions.json",
  sessionKey: "agent:main:retained-session",
  expectedSessionId: "retained-session",
};
const seed = () =>
  owners.seedRunSessionOwnerForTest("retained-session", "agent:main:retained-session");
const cleanup = (closeDatabases = false) =>
  owners.cleanupRunSessionOwnersForTest({ closeDatabases });
const draining = ["delete", "maintenance-drain", "agent-drain"];

it("retains a seeded row when its background maintenance fails", async () => {
  const failure = new Error("synthetic maintenance failed");
  fixture.drainMaintenance.mockRejectedValue(failure);
  await expect(seed()).rejects.toBe(failure);
  fixture.drainMaintenance.mockReset();
  await cleanup();
  expect(fixture.deleted).toMatchObject([expectedOwner]);
});

it("retains the original seeded owner when an agent drain fails", async () => {
  await seed();
  fixture.steps.length = 0;
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/rebound-state");
  const failure = new Error("synthetic agent drain failed");
  fixture.drainAgents.mockRejectedValue(failure);
  await expect(cleanup(true)).rejects.toBe(failure);
  expect(fixture.steps).toEqual(draining);

  fixture.steps.length = 0;
  fixture.drainAgents.mockReset();
  await cleanup(true);
  expect(fixture.deleted).toMatchObject([expectedOwner, expectedOwner]);
  expect(fixture.steps).toEqual([...draining, "agent-reset", "shared-drain", "plugin-reset"]);
  await cleanup();
  expect(fixture.deleted).toHaveLength(2);
});
