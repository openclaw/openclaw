import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { handleGoalCommand } from "./src/command.js";
import { GOAL_MAX_CONTINUATIONS, type GoalState, type GoalStore } from "./src/state.js";
import { createGoalStatusTool } from "./src/tool.js";

type ContinuationLeaseResult = Awaited<
  ReturnType<OpenClawPluginApi["session"]["workflow"]["requestSessionContinuationLease"]>
>;

function createMemoryGoalStore(): GoalStore & { states: Map<string, GoalState> } {
  const states = new Map<string, GoalState>();
  return {
    states,
    async read(sessionKey) {
      return states.get(sessionKey) ?? null;
    },
    async write(state) {
      states.set(state.sessionKey, state);
    },
    async delete(sessionKey) {
      states.delete(sessionKey);
    },
  };
}

function createApi(store = createMemoryGoalStore()) {
  const requestSessionContinuationLease = vi.fn(
    async (): Promise<ContinuationLeaseResult> => ({
      scheduled: true as const,
      handle: {
        id: "lease-job",
        pluginId: "goal",
        sessionKey: "agent:main:main",
        kind: "session-turn" as const,
      },
      replaced: { removed: 0, failed: 0 },
    }),
  );
  const clearSessionContinuationLease = vi.fn(async () => ({ removed: 1, failed: 0 }));
  const api = {
    runtime: {
      state: {
        resolveStateDir: () => "/tmp/openclaw-goal-test",
      },
    },
    session: {
      workflow: {
        requestSessionContinuationLease,
        clearSessionContinuationLease,
      },
    },
  } as unknown as OpenClawPluginApi;
  return { api, store, requestSessionContinuationLease, clearSessionContinuationLease };
}

function commandCtx(args: string, sessionKey = "agent:main:main"): PluginCommandContext {
  return {
    channel: "test",
    commandBody: `/goal ${args}`,
    args,
    isAuthorizedSender: true,
    sessionKey,
    config: {} as PluginCommandContext["config"],
    requestConversationBinding: async () => null as never,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

describe("goal plugin", () => {
  it("shows help for the agreed user command surface", async () => {
    const { api, store } = createApi();

    const result = await handleGoalCommand(api, commandCtx("help"), { store });

    expect(result.text).toContain("/goal start <objective>");
    expect(result.text).toContain("/goal status");
    expect(result.text).toContain("/goal events [n]");
    expect(result.text).toContain("/goal clear [note]");
  });

  it("starts a session-scoped goal and schedules one continuation lease", async () => {
    const { api, store, requestSessionContinuationLease } = createApi();

    const result = await handleGoalCommand(
      api,
      commandCtx("start finish the workflow lab report"),
      { store },
    );

    expect(result.text).toContain("Goal started: finish the workflow lab report");
    expect(store.states.get("agent:main:main")).toMatchObject({
      objective: "finish the workflow lab report",
      status: "continue",
      sessionKey: "agent:main:main",
    });
    expect(requestSessionContinuationLease).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sessionKey: "agent:main:main" }),
        leaseKey: "active-goal",
        deliveryMode: "announce",
      }),
    );
  });

  it("does not keep a started goal continuing when the first lease is not scheduled", async () => {
    const { api, store, requestSessionContinuationLease } = createApi();
    requestSessionContinuationLease.mockResolvedValueOnce({
      scheduled: false,
      reason: "scheduler_unavailable",
    });

    const result = await handleGoalCommand(
      api,
      commandCtx("start finish the workflow lab report"),
      { store },
    );

    expect(result.text).toContain("Continuation: not scheduled (scheduler_unavailable)");
    expect(store.states.get("agent:main:main")).toMatchObject({
      objective: "finish the workflow lab report",
      status: "waiting_approval",
      lastNote: expect.stringContaining("scheduler_unavailable"),
    });
  });

  it("shows a recent decision trail with /goal events", async () => {
    const { api, store } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    await handleGoalCommand(api, commandCtx("pause waiting for review"), { store });

    const result = await handleGoalCommand(api, commandCtx("events 5"), { store });

    expect(result.text).toContain("created continue");
    expect(result.text).toContain("lease_scheduled continue");
    expect(result.text).toContain("status paused - waiting for review");
  });

  it("keeps goal_status bound to the trusted tool-context session key", async () => {
    const { api, store, requestSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start same session only"), { store });
    requestSessionContinuationLease.mockClear();

    const tool = createGoalStatusTool(
      api,
      { sessionKey: "agent:main:main" } as Parameters<typeof createGoalStatusTool>[1],
      { store },
    );

    await expect(
      tool?.execute("call-1", {
        status: "continue",
        sessionKey: "agent:other:main",
        goalId: "not-trusted-routing",
      }),
    ).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('"ok": true') })],
    });
    expect(requestSessionContinuationLease).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sessionKey: "agent:main:main" }),
      }),
    );
    expect(requestSessionContinuationLease).not.toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sessionKey: "agent:other:main" }),
      }),
    );
  });

  it("clears the continuation lease when a goal stops", async () => {
    const { api, store, clearSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });

    const result = await handleGoalCommand(api, commandCtx("done fixed with tests"), { store });

    expect(result.text).toContain("Status: done");
    expect(clearSessionContinuationLease).toHaveBeenCalledWith({
      session: expect.objectContaining({ sessionKey: "agent:main:main" }),
      leaseKey: "active-goal",
    });
  });

  it("keeps a goal active when stop cleanup fails", async () => {
    const { api, store, clearSessionContinuationLease } = createApi();
    clearSessionContinuationLease.mockResolvedValueOnce({ removed: 0, failed: 1 });
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });

    const result = await handleGoalCommand(api, commandCtx("done fixed with tests"), { store });

    expect(result.text).toContain("Status: continue");
    expect(result.text).toContain("Could not clear the pending goal continuation");
    expect(store.states.get("agent:main:main")).toMatchObject({
      status: "continue",
      lastNote: expect.stringContaining("Could not clear the pending goal continuation"),
    });
  });

  it("clears the visible goal state and continuation lease", async () => {
    const { api, store, clearSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });

    const result = await handleGoalCommand(api, commandCtx("clear no longer needed"), { store });

    expect(result.text).toContain("Goal cleared: inspect the stuck session");
    expect(store.states.get("agent:main:main")).toBeUndefined();
    expect(clearSessionContinuationLease).toHaveBeenCalledWith({
      session: expect.objectContaining({ sessionKey: "agent:main:main" }),
      leaseKey: "active-goal",
    });
  });

  it("keeps visible goal state when clear cleanup fails", async () => {
    const { api, store, clearSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    clearSessionContinuationLease.mockResolvedValueOnce({ removed: 0, failed: 1 });

    const result = await handleGoalCommand(api, commandCtx("clear no longer needed"), { store });

    expect(result.text).toContain("Could not clear the pending goal continuation");
    expect(store.states.get("agent:main:main")).toMatchObject({
      objective: "inspect the stuck session",
      status: "continue",
    });
  });

  it("does not persist continue when goal_status cannot schedule the next lease", async () => {
    const { api, store, requestSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    requestSessionContinuationLease.mockResolvedValueOnce({
      scheduled: false,
      reason: "scheduler_unavailable",
    });

    const tool = createGoalStatusTool(
      api,
      { sessionKey: "agent:main:main" } as Parameters<typeof createGoalStatusTool>[1],
      { store },
    );

    await expect(
      tool?.execute("call-unscheduled", {
        status: "continue",
        note: "need one more pass",
      }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining('"status": "waiting_approval"'),
        }),
      ],
    });
    expect(store.states.get("agent:main:main")).toMatchObject({
      status: "waiting_approval",
      lastNote: expect.stringContaining("scheduler_unavailable"),
    });
  });

  it("keeps blocked and waiting_approval out of the user command surface", async () => {
    const { api, store } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });

    await expect(
      handleGoalCommand(api, commandCtx("blocked dependency failed"), { store }),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Unknown /goal command: blocked"),
    });
    await expect(
      handleGoalCommand(api, commandCtx("waiting_approval needs review"), { store }),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Unknown /goal command: waiting_approval"),
    });
  });

  it("does not let the model reopen a stopped goal", async () => {
    const { api, store, requestSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    await handleGoalCommand(api, commandCtx("done fixed with tests"), { store });
    requestSessionContinuationLease.mockClear();

    const tool = createGoalStatusTool(
      api,
      { sessionKey: "agent:main:main" } as Parameters<typeof createGoalStatusTool>[1],
      { store },
    );

    await expect(tool?.execute("call-2", { status: "continue" })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("only /goal resume") })],
    });
    expect(requestSessionContinuationLease).not.toHaveBeenCalled();
  });

  it("keeps done goals terminal for slash-command resume", async () => {
    const { api, store, requestSessionContinuationLease } = createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    await handleGoalCommand(api, commandCtx("done fixed with tests"), { store });
    requestSessionContinuationLease.mockClear();

    const result = await handleGoalCommand(api, commandCtx("resume"), { store });

    expect(result.text).toContain("Goal is done");
    expect(requestSessionContinuationLease).not.toHaveBeenCalled();
  });

  it("makes the loop cap an explicit start-new-goal stop", async () => {
    const { api, store, requestSessionContinuationLease, clearSessionContinuationLease } =
      createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    const current = store.states.get("agent:main:main");
    expect(current).toBeTruthy();
    store.states.set("agent:main:main", {
      ...(current as GoalState),
      continuationCount: GOAL_MAX_CONTINUATIONS,
    });
    requestSessionContinuationLease.mockClear();

    const tool = createGoalStatusTool(
      api,
      { sessionKey: "agent:main:main" } as Parameters<typeof createGoalStatusTool>[1],
      { store },
    );
    await expect(tool?.execute("call-cap", { status: "continue" })).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: expect.stringContaining('"status": "waiting_approval"') }),
      ],
    });

    expect(requestSessionContinuationLease).not.toHaveBeenCalled();
    expect(clearSessionContinuationLease).toHaveBeenCalledWith({
      session: expect.objectContaining({ sessionKey: "agent:main:main" }),
      leaseKey: "active-goal",
    });

    const result = await handleGoalCommand(api, commandCtx("resume"), { store });
    expect(result.text).toContain("start a new goal");
    expect(requestSessionContinuationLease).not.toHaveBeenCalled();
  });

  it("keeps a capped goal active when cleanup fails", async () => {
    const { api, store, requestSessionContinuationLease, clearSessionContinuationLease } =
      createApi();
    await handleGoalCommand(api, commandCtx("start inspect the stuck session"), { store });
    const current = store.states.get("agent:main:main");
    expect(current).toBeTruthy();
    store.states.set("agent:main:main", {
      ...(current as GoalState),
      continuationCount: GOAL_MAX_CONTINUATIONS,
    });
    requestSessionContinuationLease.mockClear();
    clearSessionContinuationLease.mockResolvedValueOnce({ removed: 0, failed: 1 });

    const tool = createGoalStatusTool(
      api,
      { sessionKey: "agent:main:main" } as Parameters<typeof createGoalStatusTool>[1],
      { store },
    );
    await expect(
      tool?.execute("call-cap-failed-cleanup", { status: "continue" }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Could not clear the pending goal continuation"),
        }),
      ],
    });

    expect(requestSessionContinuationLease).not.toHaveBeenCalled();
    expect(store.states.get("agent:main:main")).toMatchObject({
      status: "continue",
      lastNote: expect.stringContaining("Could not clear the pending goal continuation"),
    });
  });
});
