import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveA2aChannelAccount } from "./accounts.js";
import { a2aChannelPlugin } from "./channel.js";
import { dispatchA2aInbound } from "./inbound.js";
import { A2aTaskStore } from "./task-store.js";

type InboundParams = Parameters<typeof dispatchA2aInbound>[0];
type InboundTurn = Parameters<InboundParams["channelRuntime"]["inbound"]["dispatch"]>[0];
function dispatched(turn: InboundTurn, queuedFinal = false, deferred = false) {
  return {
    admission: { kind: "dispatch" as const },
    dispatched: true,
    ctxPayload: turn.ctxPayload,
    routeSessionKey: turn.route.sessionKey,
    dispatchResult: {
      ...createA2aDispatchResult(queuedFinal),
      ...(deferred ? { deferredToActiveRun: "followup" as const } : {}),
    },
  };
}

function createA2aDispatchResult(queuedFinal = true) {
  return { queuedFinal, counts: { tool: 0, block: 0, final: Number(queuedFinal) } };
}

const stores: A2aTaskStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.stop();
  }
  setActivePluginRegistry(createTestRegistry());
});

const registerChannel = () =>
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "a2a", plugin: a2aChannelPlugin, source: "test" }]),
  );

function createA2aInboundFixture(peerName = "hermes") {
  const runtime = createPluginRuntimeMock();
  const store = new A2aTaskStore();
  stores.push(store);
  const task = store.create("ctx-inbound", peerName);
  store.start(task.id);
  const account = resolveA2aChannelAccount({
    cfg: { channels: { a2a: { peers: { hermes: { token: "test-token" } } } } },
  });
  const params = {
    account,
    config: {},
    channelRuntime: runtime.channel,
    store,
    taskId: task.id,
    contextId: task.contextId,
    messageId: "incoming-message",
    peerName,
    text: "hello from an external agent",
  };
  return {
    store,
    task,
    params,
    dispatch: vi.mocked(runtime.channel.inbound.dispatch),
    reply: vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    run: (overrides: Partial<InboundParams> = {}) =>
      dispatchA2aInbound({ ...params, ...overrides }),
  };
}

let fixture: ReturnType<typeof createA2aInboundFixture>;
beforeEach(() => {
  fixture = createA2aInboundFixture();
});

describe("A2A channel inbound dispatch", () => {
  it("rejects peer slash commands before dispatch even with a command allowlist", async () => {
    await fixture.run({
      text: "  / custom-command",
      config: { commands: { allowFrom: { "*": ["*"] } } },
    });

    expect(fixture.task.status).toMatchObject({
      state: "TASK_STATE_REJECTED",
      message: { parts: [{ text: expect.stringContaining("only users") }] },
    });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("ignores non-final replies and supplemental notices before completing with the answer", async () => {
    registerChannel();
    fixture.reply.mockImplementation(async (turn) => {
      expect(turn.ctx).toMatchObject({
        BodyForAgent: fixture.params.text,
        CommandAuthorized: false,
        CommandInterpretationSuppressed: true,
      });
      const dispatcher = createReplyDispatcher(turn.dispatcherOptions);
      dispatcher.sendBlockReply({ text: "preview" });
      dispatcher.sendFinalReply({ text: "fallback notice", isFallbackNotice: true });
      dispatcher.sendFinalReply({ text: "thinking level clamped", isStatusNotice: true });
      dispatcher.sendFinalReply(
        setReplyPayloadMetadata({ text: "Gateway restarting" }, { hostNotice: true }),
      );
      await dispatcher.waitForIdle();
      expect(fixture.task.status.state).toBe("TASK_STATE_WORKING");
      dispatcher.sendFinalReply({ text: "agent answer" });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
    });

    await fixture.run();
    expect(fixture.task).toMatchObject({
      contextId: "ctx-inbound",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "agent answer" }] }],
    });
  });

  it.each([false, true])(
    "records a prompt-free task failure without sending an error message (queued: %s)",
    async (queued) => {
      registerChannel();
      fixture.reply.mockImplementation(async (turn) => {
        if (queued) {
          return { ...createA2aDispatchResult(false), deferredToActiveRun: "followup" };
        }
        turn.replyOptions?.onAgentRunTerminalOutcome?.("failed");
        const dispatcher = createReplyDispatcher(turn.dispatcherOptions);
        dispatcher.sendFinalReply({ text: "private prompt in provider error", isError: true });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        return createA2aDispatchResult(false);
      });
      await fixture.run();
      if (queued) {
        expect(fixture.task.status.state).toBe("TASK_STATE_WORKING");
        const turn = fixture.dispatch.mock.calls[0]![0];
        turn.replyOptions?.onAgentRunTerminalOutcome?.("failed");
      }
      expect(fixture.task.status).toMatchObject({
        state: "TASK_STATE_FAILED",
        message: { parts: [{ text: "Agent run failed" }] },
      });
      expect(fixture.task.artifacts).toEqual([]);
    },
  );

  it("matches interleaved same-context replies to their originating tasks", async () => {
    const second = fixture.store.create(fixture.task.contextId, "hermes");
    fixture.dispatch.mockImplementation(async (turn) => dispatched(turn, false, true));
    await fixture.run();
    await fixture.run({ taskId: second.id, messageId: "second" });
    const turns = fixture.dispatch.mock.calls.map(([turn]) => turn);
    await turns[1]!.delivery.deliver({ text: "second reply" }, { kind: "final" });
    await turns[0]!.delivery.deliver({ text: "first reply" }, { kind: "final" });
    expect(fixture.task.artifacts[0]?.parts).toEqual([{ text: "first reply" }]);
    expect(second.artifacts[0]?.parts).toEqual([{ text: "second reply" }]);
  });

  it("propagates dispatch failures to the HTTP task owner", async () => {
    const failure = new Error("provider unavailable");
    fixture.dispatch.mockRejectedValue(failure);
    await expect(fixture.run()).rejects.toBe(failure);
  });

  it("isolates route sessions and replies when distinct peers reuse one context ID", async () => {
    fixture.params.account.config.peers = {
      hermes: { token: "first-token" },
      crew: { token: "second-token" },
    };
    const crewTask = fixture.store.create(fixture.task.contextId, "crew");
    fixture.store.start(crewTask.id);
    fixture.dispatch.mockImplementation(async (turn) => {
      await turn.delivery.deliver({ text: String(turn.ctxPayload.From) }, { kind: "final" });
      return dispatched(turn, true);
    });
    const config = { session: { dmScope: "per-channel-peer" as const } };

    await Promise.all([
      fixture.run({ config }),
      fixture.run({ config, taskId: crewTask.id, messageId: "crew-message", peerName: "crew" }),
    ]);

    const dispatches = fixture.dispatch.mock.calls;
    expect(dispatches[0]?.[0].route.sessionKey).not.toBe(dispatches[1]?.[0].route.sessionKey);
    expect(fixture.task.artifacts[0]?.parts[0]).toEqual({ text: "a2a:hermes" });
    expect(fixture.store.get(crewTask.id)?.artifacts[0]?.parts[0]).toEqual({ text: "a2a:crew" });
  });

  it("routes a stable peer binding before account fallback while preserving exact context overrides", async () => {
    const exactTask = fixture.store.create("ctx-exact", "hermes");
    fixture.store.start(exactTask.id);
    fixture.dispatch.mockImplementation(async (turn) => dispatched(turn));
    const bindings = [
      ["a2a_context", "hermes:ctx-exact"],
      ["a2a_restricted", "hermes"],
      ["main", undefined],
    ] as const;
    const config = {
      agents: { entries: { main: {}, a2a_restricted: {}, a2a_context: {} } },
      bindings: bindings.map(([agentId, peerId]) => ({
        type: "route" as const,
        agentId,
        match: {
          channel: "a2a",
          accountId: "default",
          ...(peerId ? { peer: { kind: "direct" as const, id: peerId } } : {}),
        },
      })),
    };

    await fixture.run({ config });
    await fixture.run({
      config,
      taskId: exactTask.id,
      contextId: exactTask.contextId,
      messageId: "exact-message",
    });

    const dispatches = fixture.dispatch.mock.calls;
    expect(dispatches.map(([{ route }]) => [route.agentId, route.sessionKey])).toEqual([
      ["a2a_restricted", "agent:a2a_restricted:a2a:default:direct:hermes:ctx-inbound"],
      ["a2a_context", "agent:a2a_context:a2a:default:direct:hermes:ctx-exact"],
    ]);
    expect(fixture.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(fixture.task.artifacts).toEqual([]);
  });

  it("rejects a sender missing from the configured peer allowlist before dispatch", async () => {
    fixture = createA2aInboundFixture("unknown-peer");

    await fixture.run();

    expect(fixture.task.status.state).toBe("TASK_STATE_REJECTED");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["declines", { kind: "drop" as const, reason: "policy-blocked" }, "TASK_STATE_REJECTED"],
    ["accepts without running", { kind: "dispatch" as const }, "TASK_STATE_FAILED"],
  ])("settles tasks the runtime %s", async (_label, admission, state) => {
    fixture.dispatch.mockResolvedValue({ admission, dispatched: false });
    await fixture.run();
    expect(fixture.task.status.state).toBe(state);
  });
});
