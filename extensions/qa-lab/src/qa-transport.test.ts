import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaStateBackedTransportAdapter,
  waitForQaTransportAccountReady,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";

type State = ReturnType<typeof createQaBusState>;
let state: State;
beforeEach(() => {
  state = createQaBusState();
});
function inbound(text: string, accountId = "default", id = "alice") {
  return state.addInboundMessage({
    accountId,
    conversation: { id, kind: "direct" },
    senderId: id,
    text,
  });
}
function outbound(
  text: string,
  overrides: Partial<Parameters<State["addOutboundMessage"]>[0]> = {},
) {
  return state.addOutboundMessage({ accountId: "default", to: "dm:alice", text, ...overrides });
}
function edit(messageId: string, text = "final marker") {
  return state.editMessage({ accountId: "default", messageId, text });
}

function createAdapter(
  overrides: Partial<Parameters<typeof createQaStateBackedTransportAdapter>[1]> = {},
) {
  return createQaStateBackedTransportAdapter(state, {
    id: "live",
    label: "Live",
    accountId: "sut",
    requiredPluginIds: [],
    supportedActions: [],
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
    ...overrides,
  });
}

function waitForSequence(
  input: Partial<Parameters<typeof waitForQaTransportOutboundSequence>[0]["input"]> = {},
) {
  return waitForQaTransportOutboundSequence({
    accountId: "default",
    input: {
      conversationId: "alice",
      finalSettleMs: 0,
      finalTextIncludes: "final marker",
      minimumPreviewEvents: 1,
      timeoutMs: 25,
      ...input,
    },
    readEvents: () => state.getSnapshot().events,
  });
}

describe("waitForQaTransportAccountReady", () => {
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

    const [method, probe, request] = call.mock.calls[0] ?? [];
    expect(method).toBe("channels.status");
    expect(probe.probe).toBe(false);
    expect(probe.timeoutMs).toBeLessThanOrEqual(5);
    expect(request.timeoutMs).toBeLessThanOrEqual(5);
  });
});

describe("createQaStateBackedTransportAdapter", () => {
  it("runs transport reset before clearing shared state", async () => {
    inbound("hello");
    const resetTransport = vi.fn(() => {
      expect(state.getSnapshot().messages).toHaveLength(1);
    });
    const artifacts = [{ kind: "channel-driver-smoke" as const, path: "readiness.json" }];
    const captureArtifacts = vi.fn(async () => ({ artifacts }));
    const createRuntimePreloads = vi.fn(() => ["file:///qa-preload.mjs"]);
    const adapter = createAdapter({
      prepareFlow: vi.fn(),
      resetTransport,
      captureArtifacts,
      createRuntimePreloads,
    });

    await adapter.reset();

    expect(resetTransport).toHaveBeenCalledOnce();
    expect(adapter.prepareFlow).toBeTypeOf("function");
    await expect(adapter.captureArtifacts?.({ outputDir: "/qa-output" })).resolves.toEqual({
      artifacts,
    });
    expect(captureArtifacts).toHaveBeenCalledWith({ outputDir: "/qa-output" });
    expect(adapter.createRuntimePreloads?.()).toEqual(["file:///qa-preload.mjs"]);
    expect(createRuntimePreloads).toHaveBeenCalledOnce();
    expect(state.getSnapshot().messages).toHaveLength(0);
  });

  it("adds redacted transport and bus-kind evidence to outbound timeouts", async () => {
    state.addInboundMessage(
      {
        accountId: "sut",
        conversation: { id: "private-chat-id", kind: "group" },
        senderId: "private-sender-id",
        text: "private message content",
      },
      "private-native-message-id",
    );
    const adapter = createAdapter({
      describeTransportState: () =>
        "telegram observer polls=3; updates=2; filtered=1; matched=1; update kinds=[message]; terminal error=none",
    });

    const error = await adapter
      .waitForOutboundSequence?.({ finalTextIncludes: "missing final", timeoutMs: 5 })
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
    state.createThread({ conversationId: "qa-room", createdBy: "alice", title: "QA thread" });
    const preview = outbound("preview", {
      senderId: "openclaw",
      threadId: "42",
      to: "thread:qa-room/42",
    });
    edit(preview.id);

    await expect(
      waitForSequence({ conversationId: "qa-room", threadId: "42", timeoutMs: 100 }),
    ).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { text: "final marker", threadId: "42" },
    });
  });

  it.each([
    { description: "before the final marker", failureBeforeFinal: true },
    { description: "after the final marker", failureBeforeFinal: false },
  ])("rejects an owned-account failure reply $description", async ({ failureBeforeFinal }) => {
    const preview = outbound("owned preview");
    const addFailure = () =>
      outbound("⚠️ agent failed before reply: provider rejected this request", {
        isError: true,
      });

    if (failureBeforeFinal) {
      addFailure();
    }
    edit(preview.id);
    if (!failureBeforeFinal) {
      addFailure();
    }

    await expect(waitForSequence()).rejects.toThrow("provider rejected this request");
  });

  it("ignores stale, foreign-account, and inbound failures and final edits", async () => {
    outbound("⚠️ agent failed before reply: stale failure", { isError: true });
    const sinceCursor = state.getSnapshot().cursor;

    const foreign = outbound("⚠️ agent failed before reply: foreign account failure", {
      accountId: "other",
      isError: true,
    });
    const received = inbound("⚠️ agent failed before reply: inbound failure");
    edit(received.id, "⚠️ agent failed before reply: edited inbound failure");
    const preview = outbound("owned preview");
    edit(preview.id);
    state.editMessage({ accountId: "other", messageId: foreign.id, text: "final marker" });
    edit(received.id, "inbound preview");
    edit(received.id);

    await expect(waitForSequence({ sinceCursor })).resolves.toMatchObject({
      events: [{ kind: "sent" }, { kind: "edited" }],
      final: { accountId: "default", direction: "outbound", id: preview.id },
    });
  });

  it("does not accept a matching preview that is deleted during final settling", async () => {
    const preview = outbound("preview", { senderId: "openclaw" });
    edit(preview.id);
    setTimeout(() => {
      state.deleteMessage({ accountId: "default", messageId: preview.id });
    }, 5);

    await expect(waitForSequence({ finalSettleMs: 20, timeoutMs: 50 })).rejects.toThrow(
      "timed out after 50ms",
    );
  });

  it("does not count an already-final send as a preview", async () => {
    outbound("stale preview", { senderId: "openclaw" });
    const sinceCursor = state.getSnapshot().cursor;
    const final = outbound("final marker", { senderId: "openclaw" });
    edit(final.id);

    await expect(waitForSequence({ sinceCursor, timeoutMs: 20 })).rejects.toThrow(
      "timed out after 20ms",
    );
  });
});
