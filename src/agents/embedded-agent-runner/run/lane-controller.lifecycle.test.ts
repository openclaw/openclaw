import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { claimAgentRunContext, getAgentRunContext } from "../../../infra/agent-run-registry.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import * as sessionBootstrap from "./session-bootstrap.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

const completedResult: EmbeddedAgentRunResult = { meta: { durationMs: 0 } };

function createController(
  options: Partial<LaneParams> & { initialQueuedLifecycleGeneration?: string },
) {
  const { initialQueuedLifecycleGeneration, ...overrides } = options;
  const lifecycleGeneration = options.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const runId = options.runId ?? "run-1";
  const params: LaneParams = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "agent:main:session-1",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 30_000,
    runId,
    lifecycleGeneration,
    enqueue: options.enqueue ?? (async (task) => await task()),
    ...overrides,
  };
  return createLaneControllerFixture(params, {
    lifecycleGeneration,
    globalLane: "global-lane",
    initialQueuedLifecycleGeneration: initialQueuedLifecycleGeneration ?? lifecycleGeneration,
  });
}

function createQueuedController(options: Parameters<typeof createController>[0]) {
  const gate = createDeferred();
  const state = createController({
    ...options,
    enqueue: async (task) => {
      await gate.promise;
      return await task();
    },
  });
  const run = state.controller.enqueueGlobal(async () => completedResult);
  return { ...state, run, release: gate.resolve };
}

async function expectStaleRun(run: Promise<EmbeddedAgentRunResult>, runId: string) {
  await expect(run).rejects.toMatchObject({
    name: "AbortError",
    message: "Agent run belongs to a stale gateway lifecycle",
  });
  expect(getAgentRunContext(runId)).toBeUndefined();
}

describe("createEmbeddedRunLaneController lifecycle admission", () => {
  beforeEach(() => resetAgentEventsForTest());
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([
    { trigger: "user" as const, expected: "foreground" },
    { trigger: "cron" as const, expected: "background" },
  ])("marks $trigger session work as $expected", async ({ trigger, expected }) => {
    using writer = vi.spyOn(sessionBootstrap, "claimAgentSessionWriter");
    writer.mockResolvedValue(undefined);
    const priorities: Array<CommandQueueEnqueueOptions["priority"]> = [];
    const { controller } = createController({
      trigger,
      enqueue: async (task, options) => {
        priorities.push(options?.priority);
        return await task();
      },
    });
    await controller.enqueueSession(() => controller.enqueueGlobal(async () => completedResult));
    expect(priorities).toEqual([expected]);
  });

  it("applies the current swarm capacity only to global execution admission", async () => {
    const capacities: Array<number | undefined> = [];
    let maxConcurrent = 32;
    const { controller } = createController({
      enqueue: async (task, options) => {
        capacities.push(options?.maxConcurrent);
        return await task();
      },
      swarmExecutionLane: {
        lane: "subagent:swarm:group",
        get maxConcurrent() {
          return maxConcurrent;
        },
      },
    });
    maxConcurrent = 8;
    await controller.enqueueSession(() => controller.enqueueGlobal(async () => completedResult));
    expect(capacities).toEqual([8]);
  });

  it("preserves the selected agent for sessionless admitted runtime events", async () => {
    const runId = "sessionless-owned-run";
    const { controller } = createController({
      runId,
      agentId: "research",
      sessionKey: undefined,
    });
    const events: Array<{ agentId?: string; sessionKey?: string }> = [];
    onTestFinished(onAgentRuntimeEvent((event) => events.push(event)));
    await controller.enqueueGlobal(async () => {
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "owned progress" } });
      return completedResult;
    });
    expect(getAgentRunContext(runId)).toMatchObject({ agentId: "research" });
    expect(getAgentRunContext(runId)?.sessionKey).toBeUndefined();
    expect(events).toMatchObject([{ agentId: "research", sessionKey: undefined }]);
  });

  it("rebinds inter-session user work that was queued before lifecycle rotation", async () => {
    const state = createQueuedController({
      trigger: "user",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
      runId: "inter-session-across-restart",
    });
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    state.release();
    await state.run;
    expect(state.getLifecycleGeneration()).toBe(currentGeneration);
    expect(getAgentRunContext("inter-session-across-restart")).toMatchObject({
      lifecycleGeneration: currentGeneration,
    });
  });

  it("rejects background work queued across lifecycle rotation", async () => {
    const state = createQueuedController({
      trigger: "cron",
      runId: "background-across-restart",
    });
    rotateAgentEventLifecycleGeneration();
    state.release();
    await expectStaleRun(state.run, "background-across-restart");
  });

  it("does not claim a rebound generation after queued work was aborted", async () => {
    const abortController = new AbortController();
    const state = createQueuedController({
      trigger: "user",
      runId: "aborted-across-restart",
      abortSignal: abortController.signal,
    });
    rotateAgentEventLifecycleGeneration();
    abortController.abort();
    state.release();
    await expect(state.run).rejects.toMatchObject({ name: "AbortError" });
    expect(getAgentRunContext("aborted-across-restart")).toBeUndefined();
  });

  it("rejects stale descendants admitted only after lifecycle rotation", async () => {
    const staleGeneration = getAgentEventLifecycleGeneration();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const { controller } = createController({
      lifecycleGeneration: staleGeneration,
      initialQueuedLifecycleGeneration: currentGeneration,
      trigger: "user",
      runId: "stale-descendant",
    });

    const run = controller.enqueueGlobal(async () => completedResult);
    await expectStaleRun(run, "stale-descendant");
  });

  it("does not replace a newer same-id run context", async () => {
    const staleGeneration = getAgentEventLifecycleGeneration();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const newerContext = {
      sessionKey: "new-session-key",
      sessionId: "new-session",
      lifecycleGeneration: currentGeneration,
    };
    claimAgentRunContext("shared-run", { ...newerContext });
    const { controller } = createController({
      lifecycleGeneration: staleGeneration,
      trigger: "user",
      runId: "shared-run",
    });

    await expect(controller.enqueueGlobal(async () => completedResult)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getAgentRunContext("shared-run")).toMatchObject(newerContext);
  });
});
