import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi } from "vitest";

type MSTeamsReplyDispatcher = ReturnType<
  (typeof import("./reply-dispatcher.js"))["createMSTeamsReplyDispatcher"]
>;
type RenderMessagesMock = ReturnType<
  typeof vi.fn<(typeof import("./messenger.js"))["renderReplyPayloadsToMessages"]>
>;
type SendMessagesMock = ReturnType<
  typeof vi.fn<(typeof import("./messenger.js"))["sendMSTeamsMessages"]>
>;
type SettlementStreamMock = {
  close: ReturnType<typeof vi.fn<() => Promise<{ id: string } | undefined>>>;
  clearText: ReturnType<typeof vi.fn>;
  canceled: boolean;
  acknowledge: (text: string) => void;
};

export function registerMSTeamsReplyDispatcherSettlementTests(params: {
  createDispatcher: (
    conversationType?: string,
    msteamsConfig?: Record<string, unknown>,
    extraParams?: {
      accountId?: string;
      cfg?: Record<string, unknown>;
      onSentMessageIds?: (ids: string[]) => void;
    },
  ) => MSTeamsReplyDispatcher;
  getStreamMock: () => SettlementStreamMock;
  renderReplyPayloadsToMessagesMock: RenderMessagesMock;
  sendMSTeamsMessagesMock: SendMessagesMock;
}): void {
  const {
    createDispatcher,
    getStreamMock,
    renderReplyPayloadsToMessagesMock,
    sendMSTeamsMessagesMock,
  } = params;
  it("keeps suppressed queued sends non-visible", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue([]);
    const onSentMessageIds = vi.fn();
    const dispatcher = createDispatcher(
      "groupchat",
      { streaming: { block: { enabled: false } } },
      { onSentMessageIds },
    );

    const result = await dispatcher.delivery.deliver({ text: "hello" }, { kind: "final" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: false,
    });
    expect(onSentMessageIds).not.toHaveBeenCalled();
  });

  it("returns native stream identity and final content after close", async () => {
    const dispatcher = createDispatcher("personal");
    dispatcher.replyOptions.onPartialReply?.({ text: "streamed" });

    const result = await dispatcher.delivery.deliver({ text: "streamed final" }, { kind: "final" });
    expect(getStreamMock().close).not.toHaveBeenCalled();

    await dispatcher.dispatcherOptions.onSettled?.();
    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-final"],
      content: "streamed final",
    });
  });

  it("preserves both progress finals through real dispatcher settlement", async () => {
    renderReplyPayloadsToMessagesMock.mockImplementation((payloads) =>
      payloads.flatMap((payload) => (payload.text ? [{ text: payload.text }] : [])),
    );
    sendMSTeamsMessagesMock.mockResolvedValue(["block-result"]);
    const teams = createDispatcher("personal", { streaming: { mode: "progress" } });
    const deliveries: Array<Awaited<ReturnType<typeof teams.delivery.deliver>>> = [];
    const events: string[] = [];
    const producer = createReplyDispatcher({
      deliver: async (payload, info) => {
        events.push(`deliver:${payload.text}`);
        const result = await teams.delivery.deliver(payload, info);
        deliveries.push(result);
        return result;
      },
      onIdle: async () => {
        events.push("settle");
        await teams.dispatcherOptions.onSettled?.();
      },
    });
    producer.sendFinalReply({ text: "First distinct result." });
    producer.sendFinalReply({ text: "# Second distinct result" });
    producer.markComplete();
    await producer.waitForIdle();
    const results = await Promise.all(
      deliveries.map((result) => Promise.resolve(result?.finalization ?? result)),
    );
    expect(events).toEqual([
      "deliver:First distinct result.",
      "deliver:# Second distinct result",
      "settle",
    ]);
    for (const text of ["First distinct result.", "Second distinct result"]) {
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            visibleReplySent: true,
            content: expect.stringContaining(text),
          }),
        ]),
      );
    }
  });

  it.each(["close", "fallback"])("joins an active native %s before later blocks", async (phase) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const sent: string[] = [];
    renderReplyPayloadsToMessagesMock.mockImplementation((payloads) =>
      payloads.flatMap((payload) => (payload.text ? [{ text: payload.text }] : [])),
    );
    sendMSTeamsMessagesMock.mockImplementation(async ({ messages }) => {
      const text = messages[0]?.text ?? "";
      if (phase === "fallback" && text === "First result") {
        started.resolve();
        await release.promise;
      }
      sent.push(text);
      return [`block-${text}`];
    });
    const teams = createDispatcher("personal", {
      streaming: { mode: "progress", block: { enabled: true } },
    });
    getStreamMock().close.mockImplementation(async () => {
      if (phase === "fallback") {
        throw new Error("close failed");
      }
      started.resolve();
      await release.promise;
      sent.push("First result");
      return { id: "stream-final" };
    });
    const first = await teams.delivery.deliver({ text: "First result" }, { kind: "final" });
    const settling = teams.dispatcherOptions.onSettled?.();
    await started.promise;
    const later = teams.delivery.deliver({ text: "Second result" }, { kind: "final" });
    release.resolve();
    const second = await later;
    await settling;
    await teams.dispatcherOptions.onSettled?.();
    const results = await Promise.all([first?.finalization, second?.finalization]);
    expect(sent).toEqual(["First result", "Second result"]);
    expect(results).toEqual([
      expect.objectContaining({ visibleReplySent: true, content: "First result" }),
      expect.objectContaining({ visibleReplySent: true, content: "Second result" }),
    ]);
  });

  it.each(["partial", "progress"] as const)(
    "honors late Stop before later %s text and media",
    async (mode) => {
      renderReplyPayloadsToMessagesMock.mockImplementation((payloads) =>
        payloads.map(({ text, mediaUrl }) => ({ text, mediaUrl })),
      );
      sendMSTeamsMessagesMock.mockResolvedValue(["must-not-send"]);
      const teams = createDispatcher("personal", { streaming: { mode } });
      const stream = getStreamMock();
      if (mode === "partial") {
        teams.replyOptions.onPartialReply?.({ text: "First result" });
      }
      const first = await teams.delivery.deliver({ text: "First result" }, { kind: "final" });
      stream.acknowledge("First result");
      stream.close.mockImplementation(async () => {
        stream.canceled = true;
        return undefined;
      });
      const second = await teams.delivery.deliver(
        { text: "Second result", mediaUrl: "https://example.test/later.png" },
        { kind: "final" },
      );
      await teams.dispatcherOptions.onSettled?.();
      await expect(first?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: "First result",
      });
      expect(second).toEqual({
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      });
      expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "attached media",
      payloads: [
        {
          text: "provider final",
          mediaUrl: "https://example.test/must-not-send.png",
        },
      ],
    },
    {
      name: "media after text",
      payloads: [
        { text: "provider final" },
        { mediaUrl: "https://example.test/must-not-send.png" },
      ],
    },
    {
      name: "media before text",
      payloads: [
        { mediaUrl: "https://example.test/must-not-send.png" },
        { text: "provider final" },
      ],
    },
  ])("settles a stopped divergent final without $name fallback", async ({ payloads }) => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([
      { mediaUrl: "https://example.test/must-not-send.png" },
    ] as never);
    const dispatcher = createDispatcher("personal");
    const stream = getStreamMock();
    stream.close.mockImplementation(async () => {
      stream.canceled = true;
      return undefined;
    });

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed preview" });
    stream.acknowledge("streamed preview");
    dispatcher.replyOptions.onPartialReply?.({ text: "provider final" });
    const results = [];
    for (const payload of payloads) {
      results.push(await dispatcher.delivery.deliver(payload, { kind: "final" }));
    }
    await dispatcher.dispatcherOptions.onSettled?.();

    const nativeResult = results.find((result) => result?.finalization !== undefined);
    await expect(nativeResult?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-acknowledged"],
      content: "streamed preview",
    });
    expect(stream.clearText).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(renderReplyPayloadsToMessagesMock).not.toHaveBeenCalled();
    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
  });

  it("releases later payloads only after divergent native replacement settles", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "second payload" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["post-native-id"] as never);
    const dispatcher = createDispatcher("personal");
    const stream = getStreamMock();

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed preview" });
    stream.acknowledge("streamed preview");
    dispatcher.replyOptions.onPartialReply?.({ text: "provider final" });
    const nativeResult = await dispatcher.delivery.deliver(
      { text: "provider final" },
      { kind: "final" },
    );
    await dispatcher.delivery.deliver({ text: "second payload" }, { kind: "final" });

    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(nativeResult?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-final", "post-native-id"],
      content: "provider final\nsecond payload",
    });
    expect(renderReplyPayloadsToMessagesMock).toHaveBeenCalledWith(
      [{ text: "second payload" }],
      expect.any(Object),
    );
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("settles delivery when sent-message ID observation throws", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);
    const dispatcher = createDispatcher(
      "groupchat",
      { streaming: { block: { enabled: false } } },
      {
        onSentMessageIds: () => {
          throw new Error("observer failed");
        },
      },
    );

    const result = await dispatcher.delivery.deliver({ text: "hello" }, { kind: "final" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["id-1"],
      content: "hello",
    });
  });

  it("preserves a never-dispatched queued failure for core event suppression", async () => {
    const failure = new PlatformMessageNotDispatchedError("local media load failed", {
      cause: new Error("missing file"),
    });
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ mediaUrl: "/missing/file" }] as never);
    sendMSTeamsMessagesMock.mockRejectedValue(failure);
    const dispatcher = createDispatcher("groupchat", {
      streaming: { block: { enabled: false } },
    });

    const result = await dispatcher.delivery.deliver({ text: "attachment" }, { kind: "final" });
    const finalization = expect(result?.finalization).rejects.toBe(failure);
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;
  });
}
