import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { dispatchA2aInbound } from "./inbound.js";
import { A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

function createA2aDispatchResult(queuedFinal = true) {
  return { queuedFinal, counts: { tool: 0, block: 0, final: Number(queuedFinal) } };
}

function createA2aInboundFixture(peerName = "hermes") {
  const runtime = createPluginRuntimeMock();
  const store = new A2aTaskStore();
  const task = store.create("ctx-inbound", peerName);
  store.start(task.id);
  const account: ResolvedA2aChannelAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    config: { peers: { hermes: { token: "test-token" } } },
    unresolvedPeers: [],
    unresolvedOutboundPeers: [],
  };
  return {
    runtime,
    store,
    task,
    params: {
      account,
      config: {},
      channelRuntime: runtime.channel,
      buildContext: runtime.channel.inbound.buildContext,
      store,
      taskId: task.id,
      contextId: task.contextId,
      messageId: "incoming-message",
      peerName,
      text: "hello from an external agent",
    },
  };
}

describe("A2A channel inbound dispatch", () => {
  it("rejects peer slash commands before dispatch even with a command allowlist", async () => {
    const fixture = createA2aInboundFixture();
    try {
      await dispatchA2aInbound({
        ...fixture.params,
        text: "  / custom-command",
        config: { commands: { allowFrom: { "*": ["*"] } } },
      });

      expect(fixture.store.get(fixture.task.id)?.status).toMatchObject({
        state: "TASK_STATE_REJECTED",
        message: { parts: [{ text: expect.stringContaining("only users") }] },
      });
      expect(fixture.runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    } finally {
      fixture.store.stop();
    }
  });

  it("ignores non-final replies and supplemental notices before completing with the answer", async () => {
    const fixture = createA2aInboundFixture();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "a2a", plugin: a2aChannelPlugin, source: "test" }]),
    );
    vi.mocked(
      fixture.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).mockImplementation(async (turn) => {
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
      expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_WORKING");
      dispatcher.sendFinalReply({ text: "agent answer" });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: dispatcher.getQueuedCounts(),
      };
    });

    try {
      await dispatchA2aInbound(fixture.params);

      expect(fixture.store.get(fixture.task.id)).toEqual(
        expect.objectContaining({
          contextId: "ctx-inbound",
          status: expect.objectContaining({ state: "TASK_STATE_COMPLETED" }),
          artifacts: [expect.objectContaining({ parts: [{ text: "agent answer" }] })],
        }),
      );
    } finally {
      fixture.store.stop();
      setActivePluginRegistry(createTestRegistry());
    }
  });

  it.each([false, true])(
    "records a prompt-free task failure without sending an error message (queued: %s)",
    async (queued) => {
      const fixture = createA2aInboundFixture();
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "a2a", plugin: a2aChannelPlugin, source: "test" }]),
      );
      vi.mocked(
        fixture.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).mockImplementation(async (turn) => {
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
      try {
        await dispatchA2aInbound(fixture.params);
        if (queued) {
          expect(fixture.task.status.state).toBe("TASK_STATE_WORKING");
          const turn = vi.mocked(fixture.runtime.channel.inbound.dispatch).mock.calls[0]![0];
          turn.replyOptions?.onAgentRunTerminalOutcome?.("failed");
        }
        expect(fixture.task.status).toMatchObject({
          state: "TASK_STATE_FAILED",
          message: { parts: [{ text: "Agent run failed" }] },
        });
        expect(fixture.task.artifacts).toEqual([]);
      } finally {
        fixture.store.stop();
        setActivePluginRegistry(createTestRegistry());
      }
    },
  );

  it("matches interleaved same-context replies to their originating tasks", async () => {
    const fixture = createA2aInboundFixture();
    const second = fixture.store.create(fixture.task.contextId, "hermes");
    const turns: Parameters<typeof fixture.runtime.channel.inbound.dispatch>[0][] = [];
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockImplementation(async (turn) => {
      turns.push(turn);
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult: { ...createA2aDispatchResult(false), deferredToActiveRun: "followup" },
      };
    });
    try {
      await dispatchA2aInbound(fixture.params);
      await dispatchA2aInbound({ ...fixture.params, taskId: second.id, messageId: "second" });
      await turns[1]!.delivery.deliver({ text: "second reply" }, { kind: "final" });
      await turns[0]!.delivery.deliver({ text: "first reply" }, { kind: "final" });
      expect(fixture.task.artifacts[0]?.parts).toEqual([{ text: "first reply" }]);
      expect(second.artifacts[0]?.parts).toEqual([{ text: "second reply" }]);
    } finally {
      fixture.store.stop();
    }
  });

  it("records dispatch failures on their task", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockRejectedValue(
      new Error("provider unavailable"),
    );

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status).toEqual(
      expect.objectContaining({
        state: "TASK_STATE_FAILED",
        message: expect.objectContaining({ parts: [{ text: "provider unavailable" }] }),
      }),
    );
    fixture.store.stop();
  });

  it("isolates route sessions and replies when distinct peers reuse one context ID", async () => {
    const fixture = createA2aInboundFixture();
    fixture.params.account.config.peers = {
      hermes: { token: "first-token" },
      crew: { token: "second-token" },
    };
    const crewTask = fixture.store.create(fixture.task.contextId, "crew");
    fixture.store.start(crewTask.id);
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockImplementation(async (turn) => {
      await turn.delivery.deliver({ text: String(turn.ctxPayload.From) }, { kind: "final" });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult: createA2aDispatchResult(),
      };
    });
    const config = { session: { dmScope: "per-channel-peer" as const } };

    await Promise.all([
      dispatchA2aInbound({ ...fixture.params, config }),
      dispatchA2aInbound({
        ...fixture.params,
        config,
        taskId: crewTask.id,
        messageId: "crew-message",
        peerName: "crew",
      }),
    ]);

    const dispatches = vi.mocked(fixture.runtime.channel.inbound.dispatch).mock.calls;
    expect(dispatches[0]?.[0].route.sessionKey).not.toBe(dispatches[1]?.[0].route.sessionKey);
    expect(fixture.store.get(fixture.task.id)?.artifacts[0]?.parts[0]).toEqual({
      text: "a2a:hermes",
    });
    expect(fixture.store.get(crewTask.id)?.artifacts[0]?.parts[0]).toEqual({ text: "a2a:crew" });
    fixture.store.stop();
  });

  it("routes a stable peer binding before account fallback while preserving exact context overrides", async () => {
    const fixture = createA2aInboundFixture();
    const exactTask = fixture.store.create("ctx-exact", "hermes");
    fixture.store.start(exactTask.id);
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockImplementation(async (turn) => ({
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.route.sessionKey,
      dispatchResult: createA2aDispatchResult(false),
    }));
    const config = {
      agents: {
        entries: {
          main: {},
          a2a_restricted: {},
          a2a_context: {},
        },
      },
      bindings: [
        {
          type: "route" as const,
          agentId: "a2a_context",
          match: {
            channel: "a2a",
            accountId: "default",
            peer: { kind: "direct" as const, id: "hermes:ctx-exact" },
          },
        },
        {
          type: "route" as const,
          agentId: "a2a_restricted",
          match: {
            channel: "a2a",
            accountId: "default",
            peer: { kind: "direct" as const, id: "hermes" },
          },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "a2a", accountId: "default" },
        },
      ],
    };

    try {
      await dispatchA2aInbound({ ...fixture.params, config });
      await dispatchA2aInbound({
        ...fixture.params,
        config,
        taskId: exactTask.id,
        contextId: exactTask.contextId,
        messageId: "exact-message",
      });

      const dispatches = vi.mocked(fixture.runtime.channel.inbound.dispatch).mock.calls;
      expect(dispatches.map(([turn]) => turn.route.agentId)).toEqual([
        "a2a_restricted",
        "a2a_context",
      ]);
      expect(dispatches.map(([turn]) => turn.route.sessionKey)).toEqual([
        "agent:a2a_restricted:a2a:default:direct:hermes:ctx-inbound",
        "agent:a2a_context:a2a:default:direct:hermes:ctx-exact",
      ]);
      expect(fixture.task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(fixture.task.artifacts).toEqual([]);
    } finally {
      fixture.store.stop();
    }
  });

  it("rejects a sender missing from the configured peer allowlist before dispatch", async () => {
    const fixture = createA2aInboundFixture("unknown-peer");

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_REJECTED");
    expect(fixture.runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    fixture.store.stop();
  });

  it("rejects turns that the runtime declines instead of leaving tasks working forever", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockResolvedValue({
      admission: { kind: "drop", reason: "policy-blocked" },
      dispatched: false,
    });

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_REJECTED");
    fixture.store.stop();
  });

  it("fails turns accepted for dispatch when the runtime does not actually run them", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockResolvedValue({
      admission: { kind: "dispatch" },
      dispatched: false,
    });

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_FAILED");
    fixture.store.stop();
  });
});
