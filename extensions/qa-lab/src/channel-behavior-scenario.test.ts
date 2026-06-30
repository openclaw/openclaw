// Qa Lab tests cover reusable channel behavior scenario contracts.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  channelBehaviorConversation,
  channelBehaviorInboundMessage,
  channelBehaviorTarget,
  collectChannelBehaviorScenarioRequirements,
  defineChannelBehaviorScenario,
  defineChannelBehaviorScenarioFromConversation,
  matchesChannelBehaviorOutbound,
  runChannelBehaviorScenario,
} from "./channel-behavior-scenario.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { QaBusMessage } from "./runtime-api.js";

function outboundMessage(overrides: Partial<QaBusMessage> = {}): QaBusMessage {
  return {
    accountId: "default",
    conversation: { id: "qa-room", kind: "channel" },
    direction: "outbound",
    id: "m-out",
    reactions: [],
    senderId: "openclaw",
    text: "reply text",
    timestamp: 1,
    ...overrides,
  };
}

function createTestTransport(overrides: Partial<QaTransportAdapter> = {}): QaTransportAdapter {
  return Object.assign(createQaChannelTransport(createQaBusState()), overrides);
}

describe("channel behavior scenarios", () => {
  it("defines channel behavior scenarios with stable generated step ids", () => {
    const scenario = defineChannelBehaviorScenario({
      id: "channels.thread-reply",
      channel: { id: "qa-room", kind: "channel", title: "QA Room" },
      gatewayConfigPatch: {
        messages: { visibleReplies: "automatic" },
      },
      steps: [
        {
          name: "starts in channel",
          inbound: {
            text: "start the thread check",
          },
          expect: {
            kind: "reply",
            textIncludes: ["thread check"],
          },
        },
        {
          id: "quiet-reply",
          name: "stays quiet after unrelated reply",
          reply: { required: true, toStepId: "step-1" },
          expect: {
            kind: "no-reply",
            quietMs: 250,
          },
        },
      ],
    });

    expect(scenario.steps.map((step) => step.id)).toEqual(["step-1", "quiet-reply"]);
    expect(scenario.channel).toEqual({
      id: "qa-room",
      kind: "channel",
      title: "QA Room",
    });
  });

  it("rejects empty scenarios and duplicate step ids", () => {
    expect(() =>
      defineChannelBehaviorScenario({
        id: "channels.empty",
        channel: { id: "qa-room", kind: "channel" },
        steps: [],
      }),
    ).toThrow("channel behavior scenario channels.empty must define at least one step");

    expect(() =>
      defineChannelBehaviorScenario({
        id: "channels.duplicate",
        channel: { id: "qa-room", kind: "channel" },
        steps: [
          { id: "same", name: "first", expect: { kind: "no-reply" } },
          { id: "same", name: "second", expect: { kind: "no-reply" } },
        ],
      }),
    ).toThrow("duplicate channel behavior step id: same");
  });

  it("maps concise conversation input into a channel behavior scenario", () => {
    const scenario = defineChannelBehaviorScenario(
      defineChannelBehaviorScenarioFromConversation(
        {
          target: "dm:alice",
          from: {
            id: "alice",
            name: "Alice",
          },
          turns: [
            {
              id: "dm-reply",
              name: "gets exact marker reply",
              send: {
                text: "include QA-DM-BASELINE-OK",
              },
              expect: {
                reply: {
                  includes: ["QA-DM-BASELINE-OK"],
                  timeoutMs: 500,
                },
              },
            },
            {
              id: "quiet",
              name: "stays quiet",
              send: "do not reply",
              expect: {
                noReply: {
                  windowMs: 250,
                },
              },
            },
          ],
        },
        { scenarioId: "dm-chat-baseline" },
      ),
    );

    expect(scenario).toMatchObject({
      id: "dm-chat-baseline",
      channel: { id: "alice", kind: "direct" },
      steps: [
        {
          id: "dm-reply",
          name: "gets exact marker reply",
          inbound: {
            senderId: "alice",
            senderName: "Alice",
            text: "include QA-DM-BASELINE-OK",
          },
          expect: {
            kind: "reply",
            textIncludes: ["QA-DM-BASELINE-OK"],
            timeoutMs: 500,
          },
        },
        {
          id: "quiet",
          inbound: {
            senderId: "alice",
            senderName: "Alice",
            text: "do not reply",
          },
          expect: {
            kind: "no-reply",
            quietMs: 250,
          },
        },
      ],
    });
  });

  it("rejects in-thread conversation expectations without a created thread", () => {
    expect(() =>
      defineChannelBehaviorScenarioFromConversation(
        {
          target: "channel:qa-room",
          turns: [
            {
              send: "reply in the current thread",
              expect: {
                reply: {
                  inThread: true,
                  includes: ["done"],
                },
              },
            },
          ],
        },
        { scenarioId: "threadless" },
      ),
    ).toThrow("expects an in-thread reply but does not create a thread");
  });

  it("summarizes driver capabilities needed by channel steps", () => {
    const scenario = defineChannelBehaviorScenario({
      id: "channels.full-boundary",
      channel: { id: "qa-room", kind: "channel" },
      steps: [
        {
          id: "restart",
          name: "restart before send",
          restart: { beforeStep: true, reason: "dedupe proof" },
          inbound: {
            text: "post after restart",
            toolCalls: [{ name: "message.send" }],
          },
          thread: { createBeforeStep: true, title: "QA thread" },
          reply: { required: true, threadId: "thread-1", toStepId: "setup" },
          expect: { kind: "reply", threadId: "thread-1", textIncludes: ["done"] },
        },
      ],
    });

    expect(collectChannelBehaviorScenarioRequirements(scenario)).toEqual({
      needsGatewayRestart: true,
      needsProviderMetadata: true,
      needsReplyTargeting: true,
      needsThread: true,
    });
  });

  it("treats reply thread targets as thread requirements", () => {
    const scenario = defineChannelBehaviorScenario({
      id: "channels.threaded-reply-target",
      channel: { id: "qa-room", kind: "channel" },
      steps: [
        {
          id: "reply-to-thread",
          name: "reply to thread",
          reply: { required: true, threadId: "thread-1" },
          expect: { kind: "no-reply" },
        },
      ],
    });

    expect(collectChannelBehaviorScenarioRequirements(scenario)).toMatchObject({
      needsReplyTargeting: true,
      needsThread: true,
    });
  });

  it("formats QA-channel targets and conversations from a shared channel shape", () => {
    expect(channelBehaviorTarget({ id: "alice", kind: "direct" })).toBe("dm:alice");
    expect(channelBehaviorTarget({ id: "qa-room", kind: "channel" })).toBe("channel:qa-room");
    expect(channelBehaviorTarget({ id: "qa-room", kind: "group" })).toBe("group:qa-room");
    expect(channelBehaviorTarget({ id: "qa-room", kind: "channel" }, { threadId: "t1" })).toBe(
      "thread:qa-room/t1",
    );
    expect(() =>
      channelBehaviorTarget({ id: "alice", kind: "direct" }, { threadId: "t1" }),
    ).toThrow("only channel scenarios can target thread replies");
    expect(() =>
      channelBehaviorTarget({ id: "qa-room", kind: "group" }, { threadId: "t1" }),
    ).toThrow("only channel scenarios can target thread replies");
    expect(
      channelBehaviorConversation({ id: "qa-room", kind: "channel", title: "QA Room" }),
    ).toEqual({
      id: "qa-room",
      kind: "channel",
      title: "QA Room",
    });
  });

  it("builds inbound message input from scenario channel and step defaults", () => {
    const scenario = defineChannelBehaviorScenario({
      id: "channels.inbound",
      channel: { id: "qa-room", kind: "channel" },
      steps: [
        {
          id: "send",
          name: "send message",
          inbound: { text: "hello" },
          expect: { kind: "reply", textIncludes: ["hello"] },
        },
      ],
    });

    expect(channelBehaviorInboundMessage(scenario, scenario.steps[0])).toEqual({
      conversation: { id: "qa-room", kind: "channel" },
      senderId: "qa-operator",
      text: "hello",
    });
  });

  it("matches expected outbound replies by conversation, sender, thread, and text", () => {
    const expectation = {
      kind: "reply" as const,
      senderId: "openclaw",
      textIncludes: ["reply", "text"],
      threadId: "thread-1",
    };

    expect(
      matchesChannelBehaviorOutbound(outboundMessage({ threadId: "thread-1" }), {
        channel: { id: "qa-room", kind: "channel" },
        expectation,
      }),
    ).toBe(true);
    expect(
      matchesChannelBehaviorOutbound(
        outboundMessage({
          conversation: { id: "other-room", kind: "channel" },
          threadId: "thread-1",
        }),
        {
          channel: { id: "qa-room", kind: "channel" },
          expectation,
        },
      ),
    ).toBe(false);
    expect(
      matchesChannelBehaviorOutbound(
        outboundMessage({
          conversation: { id: "qa-room", kind: "direct" },
          threadId: "thread-1",
        }),
        {
          channel: { id: "qa-room", kind: "channel" },
          expectation,
        },
      ),
    ).toBe(false);
    expect(
      matchesChannelBehaviorOutbound(
        outboundMessage({ text: "not enough", threadId: "thread-1" }),
        {
          channel: { id: "qa-room", kind: "channel" },
          expectation,
        },
      ),
    ).toBe(false);
  });

  it("types qa transport adapters around E2E channel primitives", async () => {
    const calls: string[] = [];
    const transport = createTestTransport({
      async createThread(_input) {
        calls.push("createThread");
        return {
          accountId: "default",
          conversationId: "qa-room",
          createdAt: 1,
          createdBy: "openclaw",
          id: "thread-1",
          title: "QA thread",
        };
      },
      async observeProviderMetadata() {
        calls.push("observeProviderMetadata");
        return { provider: "mock-openai" };
      },
      async restartGateway(_hooks) {
        calls.push("restartGateway");
      },
      async sendInbound(_input) {
        calls.push("sendInbound");
        return outboundMessage({ direction: "inbound", id: "m-in", senderId: "qa-operator" });
      },
      async sendReplyTo(_input) {
        calls.push("sendReplyTo");
        return outboundMessage({ id: "m-reply", threadId: "thread-1" });
      },
      async waitForNoOutbound(_input) {
        calls.push("waitForNoOutbound");
      },
      async waitForOutbound(_input) {
        calls.push("waitForOutbound");
        return outboundMessage({ id: "m-out", threadId: "thread-1" });
      },
    });

    await transport.restartGateway({ beforeStep: true });
    await transport.createThread({ channel: { id: "qa-room", kind: "channel" } });
    await transport.sendInbound({ message: { text: "hello" } });
    await transport.waitForOutbound({
      channel: { id: "qa-room", kind: "channel" },
      expectation: { kind: "reply", textIncludes: ["hello"] },
    });
    await transport.waitForNoOutbound({ quietMs: 10 });
    await transport.sendReplyTo({ text: "reply", threadId: "thread-1" });
    await transport.observeProviderMetadata();

    expect(calls).toEqual([
      "restartGateway",
      "createThread",
      "sendInbound",
      "waitForOutbound",
      "waitForNoOutbound",
      "sendReplyTo",
      "observeProviderMetadata",
    ]);
  });

  it("runs a channel behavior scenario through driver primitives", async () => {
    const calls: string[] = [];
    const scenario = defineChannelBehaviorScenario({
      id: "channels.dm-baseline",
      channel: { id: "alice", kind: "direct" },
      steps: [
        {
          id: "reply",
          name: "gets reply",
          inbound: {
            senderId: "alice",
            text: "include QA-DM-BASELINE-OK",
          },
          expect: {
            kind: "reply",
            textIncludes: ["QA-DM-BASELINE-OK"],
            timeoutMs: 500,
          },
        },
        {
          id: "quiet",
          name: "stays quiet",
          expect: {
            kind: "no-reply",
            quietMs: 10,
          },
        },
      ],
    });
    const transport = createTestTransport({
      async createThread() {
        throw new Error("unexpected thread create");
      },
      getOutboundCursor() {
        calls.push("cursor");
        return 1;
      },
      async observeProviderMetadata() {
        return null;
      },
      async restartGateway() {
        throw new Error("unexpected restart");
      },
      async sendInbound(input) {
        calls.push(`send:${input.message.text}`);
        return outboundMessage({
          conversation: { id: "alice", kind: "direct" },
          direction: "inbound",
          id: "m-in",
          senderId: input.message.senderId,
          text: input.message.text,
        });
      },
      async sendReplyTo() {
        throw new Error("unexpected reply");
      },
      async waitForNoOutbound(input) {
        calls.push(`quiet:${input.sinceIndex}:${input.quietMs}`);
      },
      async waitForOutbound(input) {
        calls.push(`wait:${input.sinceIndex}:${input.expectation.timeoutMs}`);
        return outboundMessage({
          conversation: { id: "alice", kind: "direct" },
          id: "m-out",
          text: "done QA-DM-BASELINE-OK",
        });
      },
    });

    const result = await runChannelBehaviorScenario(scenario, transport);

    expect(result.lastOutbound?.text).toBe("done QA-DM-BASELINE-OK");
    expect(result.steps.map((step) => step.stepId)).toEqual(["reply", "quiet"]);
    expect(calls).toEqual([
      "cursor",
      "send:include QA-DM-BASELINE-OK",
      "wait:1:500",
      "cursor",
      "quiet:1:10",
    ]);
  });

  it("rejects reply-targeting steps until the runner can execute them", async () => {
    const scenario = defineChannelBehaviorScenario({
      id: "channels.reply-targeting",
      channel: { id: "qa-room", kind: "channel" },
      steps: [
        {
          id: "reply",
          name: "reply to prior message",
          reply: { required: true, toStepId: "setup" },
          expect: {
            kind: "no-reply",
            quietMs: 10,
          },
        },
      ],
    });
    const transport = createTestTransport({
      async createThread() {
        throw new Error("unexpected thread create");
      },
      async observeProviderMetadata() {
        return null;
      },
      async restartGateway() {
        throw new Error("unexpected restart");
      },
      async sendInbound() {
        throw new Error("unexpected send inbound");
      },
      async sendReplyTo() {
        throw new Error("unexpected reply");
      },
      async waitForNoOutbound() {
        throw new Error("unexpected no-reply wait");
      },
      async waitForOutbound() {
        throw new Error("unexpected outbound wait");
      },
    });

    await expect(runChannelBehaviorScenario(scenario, transport)).rejects.toThrow(
      "declares reply targeting",
    );
  });

  it("pins reply expectations to a thread created for the step", async () => {
    const scenario = defineChannelBehaviorScenario({
      id: "channels.thread-reply",
      channel: { id: "qa-room", kind: "channel" },
      steps: [
        {
          id: "threaded",
          name: "reply inside created thread",
          thread: { createBeforeStep: true, title: "QA thread" },
          inbound: { text: "reply in thread" },
          expect: {
            kind: "reply",
            textIncludes: ["done"],
          },
        },
      ],
    });
    let waitedThreadId: string | undefined;
    const transport = createTestTransport({
      async createThread() {
        return {
          accountId: "default",
          conversationId: "qa-room",
          createdAt: 1,
          createdBy: "openclaw",
          id: "thread-1",
          title: "QA thread",
        };
      },
      async observeProviderMetadata() {
        return null;
      },
      async restartGateway() {
        throw new Error("unexpected restart");
      },
      async sendInbound(input) {
        expect(input.message.threadId).toBe("thread-1");
        return outboundMessage({
          conversation: { id: "qa-room", kind: "channel" },
          direction: "inbound",
          id: "m-in",
          senderId: "qa-operator",
          text: input.message.text,
          threadId: input.message.threadId,
        });
      },
      async sendReplyTo() {
        throw new Error("unexpected reply");
      },
      async waitForNoOutbound() {
        throw new Error("unexpected no-reply wait");
      },
      async waitForOutbound(input) {
        waitedThreadId = input.expectation.threadId;
        return outboundMessage({
          id: "m-out",
          text: "done",
          threadId: input.expectation.threadId,
        });
      },
    });

    await runChannelBehaviorScenario(scenario, transport);

    expect(waitedThreadId).toBe("thread-1");
  });

  it("uses qa-channel transport defaults for channel scenario primitives", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    transport.handleAction = async ({ args }) => {
      const details = {
        thread: {
          accountId: "default",
          conversationId: String(args.channelId),
          createdAt: 1,
          createdBy: "openclaw",
          id: "thread-1",
          title: typeof args.title === "string" ? args.title : "QA thread",
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    };
    state.addOutboundMessage({
      to: "dm:alice",
      text: "old reply",
    });
    const cursor = transport.getOutboundCursor();
    state.addOutboundMessage({
      to: "dm:alice",
      text: "new reply QA-DM-BASELINE-OK",
    });

    const inbound = await transport.sendInbound({
      channel: { id: "alice", kind: "direct" },
      message: {
        text: "hello",
      },
    });
    const outbound = await transport.waitForOutbound({
      channel: { id: "alice", kind: "direct" },
      expectation: {
        kind: "reply",
        textIncludes: ["QA-DM-BASELINE-OK"],
      },
      sinceIndex: cursor,
    });
    const thread = await transport.createThread({
      channel: { id: "qa-room", kind: "channel" },
      cfg: {} as OpenClawConfig,
      title: "QA thread",
    });

    expect(inbound).toMatchObject({
      conversation: { id: "alice", kind: "direct" },
      direction: "inbound",
      senderId: "qa-operator",
      text: "hello",
    });
    expect(outbound.text).toBe("new reply QA-DM-BASELINE-OK");
    expect(thread).toMatchObject({
      conversationId: "qa-room",
      id: "thread-1",
      title: "QA thread",
    });
  });
});
