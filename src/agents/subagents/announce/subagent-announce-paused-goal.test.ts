import { afterEach, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  createSubagentRunRecord,
  taskCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import * as registryRead from "../registry/subagent-registry-read.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";
import * as announceRuntime from "./subagent-announce.runtime.js";

const sessionKey = "agent:main:paused-goal";
const childSessionKey = "agent:main:subagent:paused-goal-child";
const earlierChildSessionKey = "agent:main:subagent:paused-goal-earlier";
const laterChildSessionKey = "agent:main:subagent:paused-goal-later";
const pausedAt = 1_000;
const childResult = "finished slice output";
const failedNotice = "No answer was returned. Ask again if you still need one.";
const settleFindings = "earlier slice output\n\nlater slice output";
const storePath = "/synthetic/paused-goal/sessions.json";
const shown = (text: string) => `[Subagent result (goal paused)]\n\n${text}`;

type ChildSpawn = { sessionKey: string; createdAt: number; startedAt: number };

function goal(status: "paused" | "active", stamp?: number): SessionGoal {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "finish the slice",
    status,
    createdAt: 1,
    updatedAt: stamp ?? 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
    ...(stamp === undefined ? {} : { pausedAt: stamp }),
  };
}

function childRun(childKey: string, createdAt: number, startedAt: number) {
  return createSubagentRunRecord({
    runId: `run-${childKey.split(":").at(-1)}`,
    childSessionKey: childKey,
    requesterSessionKey: sessionKey,
    createdAt,
    startedAt,
  });
}

const registrySpies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of registrySpies.splice(0)) {
    spy.mockRestore();
  }
  testing.setDepsForTest();
});

function deliver(options: {
  goal: SessionGoal;
  createdAt: number;
  startedAt: number;
  completionTarget?: "parent";
  noOutput?: boolean;
  result?: string;
  status?: "ok" | "error";
  omitEvents?: boolean;
  sourceTool?: string;
  expectsCompletionMessage?: boolean;
  pausedGoalVisibleText?: string;
  directOrigin?: { channel: string; to: string };
  spawns?: ChildSpawn[];
  onBeforeDispatch?: () => void | Promise<void>;
  onAccepted?: (payload: unknown) => void;
}) {
  const cfg: OpenClawConfig = { session: { store: storePath } };
  const entry = {
    sessionId: "requester-session",
    lifecycleRevision: "requester-revision",
    updatedAt: 1,
    goal: options.goal,
  };
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    agentId: "main",
    incarnation: entry.sessionId,
  });
  const dispatch = vi.fn(async function <T>(
    ...args: Parameters<typeof dispatchGatewayMethodInProcess>
  ) {
    void args;
    return { status: "accepted" } as T;
  });
  const spawns = options.spawns ?? [
    { sessionKey: childSessionKey, createdAt: options.createdAt, startedAt: options.startedAt },
  ];
  const runs = new Map(
    spawns.map((spawn) => [
      spawn.sessionKey,
      childRun(spawn.sessionKey, spawn.createdAt, spawn.startedAt),
    ]),
  );
  const inject = vi
    .spyOn(announceRuntime, "commitRequesterSubagentResult")
    .mockResolvedValue(undefined);
  registrySpies.push(
    inject,
    vi
      .spyOn(registryRead, "getLatestLiveSubagentRunByChildSessionKey")
      .mockImplementation((key) => runs.get(key) ?? null),
  );
  testing.setDepsForTest({
    getRuntimeConfig: () => cfg,
    loadRequesterSessionEntry: (key) => ({
      cfg,
      canonicalKey: key,
      agentId: "main",
      storePath,
      entry,
    }),
    getRequesterSessionActivity: () => ({
      sessionId: entry.sessionId,
      isActive: false,
      target,
    }),
    dispatchGatewayMethodInProcess: dispatch,
  });
  const run = () =>
    deliverSubagentAnnouncement({
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      targetRequesterSessionKey: sessionKey,
      triggerMessage: "A background task finished.",
      ...(options.omitEvents
        ? {}
        : {
            internalEvents: taskCompletionEvents({
              childSessionKey: spawns[0]?.sessionKey ?? childSessionKey,
              result: options.noOutput ? "(no output)" : (options.result ?? childResult),
              ...(options.noOutput
                ? { status: options.status ?? ("error" as const), noVisibleResult: true }
                : options.status
                  ? { status: options.status }
                  : {}),
            }),
          }),
      sourceSessionKey: spawns[0]?.sessionKey ?? childSessionKey,
      ...(spawns.length > 1
        ? { settleWakeSourceSessionKeys: spawns.map((spawn) => spawn.sessionKey) }
        : {}),
      ...(options.pausedGoalVisibleText
        ? { pausedGoalVisibleText: options.pausedGoalVisibleText }
        : {}),
      ...(options.directOrigin ? { directOrigin: options.directOrigin } : {}),
      sourceTool: options.sourceTool ?? "subagent_announce",
      requesterIsSubagent: false,
      expectsCompletionMessage: options.expectsCompletionMessage ?? true,
      directIdempotencyKey: "paused-goal-completion",
      isSourceSessionEffectsAllowed: () => true,
      ...(options.completionTarget
        ? {
            completionTarget: options.completionTarget,
            completionRequesterSessionId: entry.sessionId,
            completionRequesterLifecycleRevision: entry.lifecycleRevision,
          }
        : {}),
      onBeforeDispatch: options.onBeforeDispatch,
      onAccepted: options.onAccepted,
    });
  return { dispatch, inject, run };
}

function methods(fixture: Pick<ReturnType<typeof deliver>, "dispatch" | "inject">) {
  return [
    ...fixture.inject.mock.calls.map(() => "inject"),
    ...fixture.dispatch.mock.calls.map((call) => call[0]),
  ];
}

it("injects a child result spawned before a paused goal without a requester turn", async () => {
  let prepared = false;
  const accepted: unknown[] = [];
  const fixture = deliver({
    goal: goal("paused", pausedAt),
    createdAt: 100,
    startedAt: 200,
    onBeforeDispatch: () => {
      prepared = true;
    },
    onAccepted: (payload) => {
      accepted.push(payload);
    },
  });
  fixture.inject.mockImplementation(async () => {
    expect(prepared).toBe(true);
  });
  const result = await fixture.run();
  expect(result).toMatchObject({ delivered: true, path: "direct" });
  expect(methods(fixture)).toEqual(["inject"]);
  expect(fixture.inject.mock.calls[0]?.[0]).toMatchObject({
    sessionKey,
    agentId: "main",
    expectedGeneration: { sessionId: "requester-session", lifecycleRevision: "requester-revision" },
    text: shown(childResult),
    idempotencyKey: "paused-goal-completion:paused-goal",
  });
  expect(accepted).toEqual([undefined]);
});

it("reuses one idempotency key when a paused-goal completion is retried", async () => {
  const fixture = deliver({ goal: goal("paused", pausedAt), createdAt: 100, startedAt: 200 });
  await fixture.run();
  await fixture.run();
  const keys = fixture.inject.mock.calls.map((call) => call[0].idempotencyKey);
  expect(keys).toEqual([
    "paused-goal-completion:paused-goal",
    "paused-goal-completion:paused-goal",
  ]);
  expect(methods(fixture)).not.toContain("agent");
});

it.each([
  { name: "a child spawned after the pause", goal: goal("paused", pausedAt), createdAt: 1_500 },
  { name: "an active goal", goal: goal("active", pausedAt), createdAt: 100 },
  {
    name: "a parent-only completion",
    goal: goal("paused", pausedAt),
    createdAt: 100,
    completionTarget: "parent" as const,
  },
  {
    name: "a requester with an external delivery route",
    goal: goal("paused", pausedAt),
    createdAt: 100,
    directOrigin: { channel: "telegram", to: "12345" },
  },
  {
    name: "a successful child with no output",
    goal: goal("paused", pausedAt),
    createdAt: 100,
    noOutput: true,
    status: "ok" as const,
  },
  {
    name: "a child with no visible text",
    goal: goal("paused", pausedAt),
    createdAt: 100,
    result: "   ",
  },
])("keeps the requester turn for $name", async ({ name: _name, ...options }) => {
  const fixture = deliver({ ...options, startedAt: options.createdAt + 100 });
  await fixture.run();
  expect(methods(fixture)).toEqual(["agent"]);
  expect(JSON.stringify(fixture.dispatch.mock.calls)).not.toContain(failedNotice);
});

it("injects settle-wake findings for children spawned before a paused goal", async () => {
  const fixture = deliver({
    goal: goal("paused", pausedAt),
    createdAt: 100,
    startedAt: 200,
    omitEvents: true,
    sourceTool: "subagent_settle",
    expectsCompletionMessage: false,
    pausedGoalVisibleText: settleFindings,
    spawns: [
      { sessionKey: earlierChildSessionKey, createdAt: 100, startedAt: 200 },
      { sessionKey: laterChildSessionKey, createdAt: 300, startedAt: 400 },
    ],
  });
  const result = await fixture.run();
  expect(result).toMatchObject({ delivered: true, path: "direct" });
  expect(methods(fixture)).toEqual(["inject"]);
  expect(fixture.inject.mock.calls[0]?.[0]).toMatchObject({
    sessionKey,
    text: shown(settleFindings),
  });
  expect(JSON.stringify(fixture.dispatch.mock.calls)).not.toContain(failedNotice);
});

it.each([
  {
    name: "failed",
    options: { result: "the child run stopped with an error", status: "error" as const },
  },
  { name: "produced no output", options: { noOutput: true } },
])("injects the failed notice when a pre-pause child $name", async ({ options }) => {
  const fixture = deliver({
    goal: goal("paused", pausedAt),
    createdAt: 100,
    startedAt: 200,
    ...options,
  });
  const result = await fixture.run();
  expect(result).toMatchObject({ delivered: true, path: "direct" });
  expect(methods(fixture)).toEqual(["inject"]);
  expect(fixture.inject.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ text: shown(failedNotice) }),
  );
});
