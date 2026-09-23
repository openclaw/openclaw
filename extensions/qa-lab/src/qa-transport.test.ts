// Qa Lab tests cover shared transport behavior.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaStateBackedTransportAdapter,
  waitForQaTransportAccountReady,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";

describe("waitForQaTransportAccountReady", () => {
  it.each([
    { description: "disconnected", connected: false, lifecycle: "starting" },
    { description: "unauthenticated", connected: true, lifecycle: "starting" },
    { description: "blocked", connected: true, lifecycle: "blocked" },
  ])("does not declare a $description account ready", async ({ connected, lifecycle }) => {
    const gateway = {
      call: vi.fn().mockResolvedValue({
        channelAccounts: {
          slack: [{ accountId: "sut", connected, lifecycle, running: true }],
        },
      }),
    };

    await expect(
      waitForQaTransportAccountReady({
        accountId: "sut",
        channel: "slack",
        gateway,
        pollIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(`"lifecycle":"${lifecycle}"`);
  });

  it("keeps channel-status probes inside the readiness deadline", async () => {
    const call = vi.fn().mockResolvedValue({ channelAccounts: {} });

    await expect(
      waitForQaTransportAccountReady({
        accountId: "sut",
        channel: "slack",
        gateway: { call },
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out after 5ms waiting for slack ready");

    expect(call).toHaveBeenCalledWith(
      "channels.status",
      { probe: false, timeoutMs: expect.any(Number) },
      { timeoutMs: expect.any(Number) },
    );
    const [, probe, request] = call.mock.calls[0] ?? [];
    expect(probe.timeoutMs).toBeLessThanOrEqual(5);
    expect(request.timeoutMs).toBeLessThanOrEqual(5);
  });
});

describe("createQaStateBackedTransportAdapter", () => {
  it("runs transport reset before clearing shared state", async () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "hello",
    });
    const resetTransport = vi.fn(() => {
      expect(state.getSnapshot().messages).toHaveLength(1);
    });
    const captureArtifacts = vi.fn(async () => ({
      artifacts: [{ kind: "channel-driver-smoke" as const, path: "readiness.json" }],
    }));
    const createRuntimePreloads = vi.fn(() => ["file:///qa-preload.mjs"]);
    const adapter = createQaStateBackedTransportAdapter(state, {
      id: "live",
      label: "Live",
      accountId: "sut",
      requiredPluginIds: [],
      prepareFlow: vi.fn(),
      supportedActions: [],
      resetTransport,
      captureArtifacts,
      createRuntimePreloads,
      sendInbound: async (input) => state.addInboundMessage(input),
      createGatewayConfig: () => ({}),
      waitReady: async () => undefined,
      buildAgentDelivery: ({ target }) => ({
        channel: "live",
        to: target,
        replyChannel: "live",
        replyTo: target,
      }),
      handleAction: async () => undefined,
      createReportNotes: () => [],
    });

    await adapter.reset();

    expect(resetTransport).toHaveBeenCalledOnce();
    expect(adapter.prepareFlow).toBeTypeOf("function");
    await expect(adapter.captureArtifacts?.({ outputDir: "/qa-output" })).resolves.toEqual({
      artifacts: [{ kind: "channel-driver-smoke", path: "readiness.json" }],
    });
    expect(captureArtifacts).toHaveBeenCalledWith({ outputDir: "/qa-output" });
    expect(adapter.createRuntimePreloads?.()).toEqual(["file:///qa-preload.mjs"]);
    expect(createRuntimePreloads).toHaveBeenCalledOnce();
    expect(state.getSnapshot().messages).toHaveLength(0);
  });

  it("adds redacted transport and bus-kind evidence to outbound timeouts", async () => {
    const state = createQaBusState();
    state.addInboundMessage(
      {
        accountId: "sut",
        conversation: { id: "private-chat-id", kind: "group" },
        senderId: "private-sender-id",
        text: "private message content",
      },
      "private-native-message-id",
    );
    const adapter = createQaStateBackedTransportAdapter(state, {
      id: "live",
      label: "Live",
      accountId: "sut",
      requiredPluginIds: [],
      supportedActions: [],
      describeTransportState: () =>
        "telegram observer polls=3; updates=2; filtered=1; matched=1; update kinds=[message]; terminal error=none",
      sendInbound: async (input) => state.addInboundMessage(input),
      createGatewayConfig: () => ({}),
      waitReady: async () => undefined,
      buildAgentDelivery: ({ target }) => ({
        channel: "live",
        to: target,
        replyChannel: "live",
        replyTo: target,
      }),
      handleAction: async () => undefined,
      createReportNotes: () => [],
    });

    const error = await adapter
      .waitForOutboundSequence?.({
        finalTextIncludes: "missing final",
        timeoutMs: 5,
      })
      .catch((caught: unknown) => caught);
    const message = String(error);

    expect(message).toContain(
      "telegram observer polls=3; updates=2; filtered=1; matched=1; update kinds=[message]; terminal error=none",
    );
    expect(message).toContain("final bus-event kinds=[inbound-message]");
    expect(message).not.toMatch(
      /private-chat-id|private-sender-id|private message content|private-native-message-id/u,
    );
  });
});

describe("waitForQaTransportOutboundSequence", () => {
  it("returns preview and final edit events for one threaded message", async () => {
    const state = createQaBusState();
    state.createThread({
      conversationId: "qa-room",
      createdBy: "alice",
      title: "QA thread",
    });
    const preview = state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "preview",
      threadId: "42",
      to: "thread:qa-room/42",
    });
    state.editMessage({
      accountId: "default",
      messageId: preview.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "qa-room",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          threadId: "42",
          timeoutMs: 100,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { text: "final marker", threadId: "42" },
    });
  });

  it("returns preview and final sends across distinct messages", async () => {
    const state = createQaBusState();
    const preview = state.addOutboundMessage({
      accountId: "default",
      text: "preview",
      to: "dm:alice",
    });
    const final = state.addOutboundMessage({
      accountId: "default",
      text: "final marker",
      to: "dm:alice",
    });

    const sequence = await waitForQaTransportOutboundSequence({
      accountId: "default",
      input: {
        conversationId: "alice",
        finalSettleMs: 0,
        finalTextIncludes: "final marker",
        minimumPreviewEvents: 1,
        timeoutMs: 100,
      },
      readEvents: () => state.getSnapshot().events,
    });

    expect(sequence.events.map(({ kind, message }) => [kind, message.id])).toEqual([
      ["sent", preview.id],
      ["sent", final.id],
    ]);
    expect(sequence.final).toMatchObject({ id: final.id, text: "final marker" });
  });

  it.each([
    { description: "before the final marker", failureBeforeFinal: true },
    { description: "after the final marker", failureBeforeFinal: false },
  ])("rejects an owned-account failure reply $description", async ({ failureBeforeFinal }) => {
    const state = createQaBusState();
    const preview = state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      text: "owned preview",
    });
    const addFailure = () =>
      state.addOutboundMessage({
        accountId: "default",
        to: "dm:alice",
        isError: true,
        text: "⚠️ agent failed before reply: provider rejected this request",
      });

    if (failureBeforeFinal) {
      addFailure();
    }
    state.editMessage({
      accountId: "default",
      messageId: preview.id,
      text: "final marker",
    });
    if (!failureBeforeFinal) {
      addFailure();
    }

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          timeoutMs: 25,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).rejects.toThrow("provider rejected this request");
  });

  it("ignores stale, foreign-account, and inbound failure replies", async () => {
    const state = createQaBusState();
    state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      isError: true,
      text: "⚠️ agent failed before reply: stale failure",
    });
    const sinceCursor = state.getSnapshot().cursor;

    state.addOutboundMessage({
      accountId: "other",
      to: "dm:alice",
      isError: true,
      text: "⚠️ agent failed before reply: foreign account failure",
    });
    const inbound = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "⚠️ agent failed before reply: inbound failure",
    });
    state.editMessage({
      accountId: "default",
      messageId: inbound.id,
      text: "⚠️ agent failed before reply: edited inbound failure",
    });
    const preview = state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      text: "owned preview",
    });
    state.editMessage({
      accountId: "default",
      messageId: preview.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          sinceCursor,
          timeoutMs: 25,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { accountId: "default", direction: "outbound", id: preview.id },
    });
  });

  it("does not accept a matching preview that is deleted during final settling", async () => {
    const state = createQaBusState();
    const preview = state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "preview",
      to: "dm:alice",
    });
    state.editMessage({
      accountId: "default",
      messageId: preview.id,
      text: "final marker",
    });
    setTimeout(() => {
      state.deleteMessage({ accountId: "default", messageId: preview.id });
    }, 5);

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 20,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          timeoutMs: 50,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).rejects.toThrow("timed out after 50ms");
  });

  it("does not count an already-final send as a preview", async () => {
    const state = createQaBusState();
    state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "stale preview",
      to: "dm:alice",
    });
    const sinceCursor = state.getSnapshot().cursor;
    const final = state.addOutboundMessage({
      accountId: "default",
      senderId: "openclaw",
      text: "final marker",
      to: "dm:alice",
    });
    state.editMessage({
      accountId: "default",
      messageId: final.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          sinceCursor,
          timeoutMs: 20,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).rejects.toThrow("timed out after 20ms");
  });

  it("ignores foreign-account and inbound edit events when proving a final reply", async () => {
    const state = createQaBusState();
    const expected = state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      text: "owned preview",
    });
    state.editMessage({
      accountId: "default",
      messageId: expected.id,
      text: "final marker",
    });

    const foreign = state.addOutboundMessage({
      accountId: "other",
      to: "dm:alice",
      text: "foreign preview",
    });
    state.editMessage({
      accountId: "other",
      messageId: foreign.id,
      text: "final marker",
    });

    const inbound = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "inbound original",
    });
    state.editMessage({
      accountId: "default",
      messageId: inbound.id,
      text: "inbound preview",
    });
    state.editMessage({
      accountId: "default",
      messageId: inbound.id,
      text: "final marker",
    });

    await expect(
      waitForQaTransportOutboundSequence({
        accountId: "default",
        input: {
          conversationId: "alice",
          finalSettleMs: 0,
          finalTextIncludes: "final marker",
          minimumPreviewEvents: 1,
          timeoutMs: 50,
        },
        readEvents: () => state.getSnapshot().events,
      }),
    ).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { accountId: "default", direction: "outbound", id: expected.id },
    });
  });
});

describe("waitForOutbound expected failures", () => {
  function createFixture() {
    const state = createQaBusState();
    const assertTransportHealthy = vi.fn();
    const adapter = createQaStateBackedTransportAdapter(state, {
      id: "live",
      label: "Live",
      accountId: "sut",
      requiredPluginIds: [],
      supportedActions: [],
      assertTransportHealthy,
      sendInbound: async (input) => state.addInboundMessage(input),
      createGatewayConfig: () => ({}),
      waitReady: async () => undefined,
      buildAgentDelivery: ({ target }) => ({
        channel: "live",
        to: target,
        replyChannel: "live",
        replyTo: target,
      }),
      handleAction: async () => undefined,
      createReportNotes: () => [],
    });
    const expectedFailure = {
      conversation: { id: "qa-operator", kind: "direct" as const },
      senderId: "openclaw",
      threadId: null,
      text: "denied: Tool blocked_action not found",
    };
    const outbound = {
      accountId: "sut",
      senderId: "openclaw",
      text: expectedFailure.text,
      to: "dm:qa-operator",
    };
    return { state, adapter, assertTransportHealthy, expectedFailure, outbound };
  }

  it("still rejects an exact failure reply in the default success-only wait", async () => {
    const { state, adapter, expectedFailure, outbound } = createFixture();
    state.addOutboundMessage(outbound);

    await expect(
      adapter.waitForOutbound({ textIncludes: expectedFailure.text, sinceIndex: 0 }),
    ).rejects.toThrow(expectedFailure.text);
  });

  it("consumes successive expected replies with global cursors and leaves normal waits strict", async () => {
    const { state, adapter, expectedFailure, outbound } = createFixture();
    state.addOutboundMessage({ ...outbound, accountId: "other" });
    for (const marker of ["first", "second"]) {
      const sinceIndex = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
      const text = `${marker}: Tool blocked_action not found`;
      state.addInboundMessage({
        conversation: expectedFailure.conversation,
        senderId: "qa-operator",
        text: expectedFailure.text,
      });
      state.addOutboundMessage({ ...outbound, accountId: "other" });
      const message = state.addOutboundMessage({ ...outbound, text });

      await expect(
        adapter.waitForOutbound({ expectedFailure: { ...expectedFailure, text }, sinceIndex }),
      ).resolves.toEqual(message);
    }
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    const final = state.addOutboundMessage({ ...outbound, text: "normal completion" });
    await expect(
      adapter.waitForOutbound({ textIncludes: "normal completion", sinceIndex }),
    ).resolves.toEqual(final);
    expect(
      state.getSnapshot().messages.filter((message) => message.accountId === "sut"),
    ).toHaveLength(3);
  });

  it.each([
    { description: "another conversation", change: { to: "dm:other" } },
    { description: "another conversation kind", change: { to: "channel:qa-operator" } },
    { description: "another sender", change: { senderId: "other" } },
    { description: "an unexpected thread", change: { threadId: "42" } },
    {
      description: "extra failure text",
      change: { text: "denied: Tool blocked_action not found; extra" },
    },
  ])("rejects an expected-looking failure from $description", async ({ change }) => {
    const { state, adapter, expectedFailure, outbound } = createFixture();
    const message = state.addOutboundMessage({ ...outbound, ...change });

    await expect(adapter.waitForOutbound({ expectedFailure, sinceIndex: 0 })).rejects.toThrow(
      message.text,
    );
  });

  it.each(["before", "after", "duplicate"] as const)(
    "rejects another failure %s the expected candidate",
    async (position) => {
      const { state, adapter, expectedFailure, outbound } = createFixture();
      const other = {
        ...outbound,
        to: "dm:other",
        text: "unexpected: Tool other_action not found",
      };
      if (position === "before") {
        state.addOutboundMessage(other);
      }
      state.addOutboundMessage(outbound);
      if (position !== "before") {
        state.addOutboundMessage(position === "duplicate" ? outbound : other);
      }

      await expect(adapter.waitForOutbound({ expectedFailure, sinceIndex: 0 })).rejects.toThrow(
        position === "duplicate" ? expectedFailure.text : other.text,
      );
    },
  );

  it("cannot accept a deleted candidate", async () => {
    const { state, adapter, expectedFailure, outbound } = createFixture();
    const message = state.addOutboundMessage(outbound);
    state.deleteMessage({ accountId: "sut", messageId: message.id });

    await expect(adapter.waitForOutbound({ expectedFailure, sinceIndex: 0 })).rejects.toThrow(
      expectedFailure.text,
    );
  });

  it("cannot accept a stale candidate or another account's current reply", async () => {
    const { state, adapter, expectedFailure, outbound } = createFixture();
    state.addOutboundMessage(outbound);
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    state.addOutboundMessage({ ...outbound, accountId: "other" });

    await expect(
      adapter.waitForOutbound({ expectedFailure, sinceIndex, timeoutMs: 5 }),
    ).rejects.toThrow("timed out after 5ms");
  });

  it("requires the exact declared thread", async () => {
    const { state, adapter, expectedFailure, outbound } = createFixture();
    const message = state.addOutboundMessage({ ...outbound, threadId: "42" });

    await expect(
      adapter.waitForOutbound({
        expectedFailure: { ...expectedFailure, threadId: "42" },
        sinceIndex: 0,
      }),
    ).resolves.toEqual(message);
  });

  it("preserves transport health failures even with an exact candidate", async () => {
    const { state, adapter, assertTransportHealthy, expectedFailure, outbound } = createFixture();
    state.addOutboundMessage(outbound);
    const failure = new Error("transport closed");
    assertTransportHealthy.mockImplementation(() => {
      throw failure;
    });

    await expect(adapter.waitForOutbound({ expectedFailure, sinceIndex: 0 })).rejects.toBe(failure);
  });
});
