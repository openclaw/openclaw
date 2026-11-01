import "./reply-dispatcher.tables.test-support.js";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { buildFeishuPostMessageContent } from "./markdown.js";
import type { FeishuStreamingSession } from "./streaming-card.js";

const {
  createBlockTableHarness,
  createDispatcherHarness,
  createFeishuClientMock,
  createReplyAccount,
  installTableDispatcherHarness,
  pipelessTableMarkdown,
  requireStreamingInstance,
  resolveFeishuAccountMock,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  streamingInstances,
  tableCfg,
  tableMarkdown,
  useRealMarkdownChunker,
} = await import("./reply-dispatcher.tables.test-support.js");
type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;

describe("createFeishuReplyDispatcher block table receipts", () => {
  installTableDispatcherHarness();

  it.each(["answer", "reasoning"] as const)(
    "shows off-mode %s tables literally without changing the eventual post",
    async (stream) => {
      const { result, options } = createBlockTableHarness(tableCfg("off"), true);
      const text = [
        tableMarkdown,
        "City | Country\n:--- | ---:\nParis | France",
        "> Animal | Sound\n> --- | ---\n> Cat | Meow",
        "```\n| Sample |\n| --- |\n| Literal |\n```",
      ].join("\n\n");
      if (stream === "reasoning") {
        result.replyOptions.onReasoningStream?.({ text });
      } else {
        result.replyOptions.onPartialReply?.({ text });
      }
      const instance = requireStreamingInstance(0);
      await instance.updated.promise;
      const shown = String(instance.update.mock.calls.at(-1)?.[0] ?? "");
      expect(shown).toContain("| &#45;-- | --- |");
      expect(shown).toContain(":&#45;-- | ---:");
      expect(shown).toContain("> &#45;-- | ---");
      expect(shown).toContain("| Sample |");
      expect(shown).toContain("| --- |");
      expect(shown).toContain("Ada | Lead");
      expect(shown).toContain("Paris | France");
      expect(shown).toContain("Cat | Meow");
      await options.onIdle?.();
      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
      const posted = String(sendMessageFeishuMock.mock.calls[0]?.[0]?.text ?? "");
      expect(posted).not.toContain("&#45;");
      expect(posted).toContain("| --- | --- |");
      expect(posted).toContain("Ada | Lead");
    },
  );

  it.each([
    { waiter: "idle", phase: "with reasoning for idle", pending: false },
    { waiter: "idle", phase: "with reasoning for idle", pending: true },
    { waiter: "final", phase: "after final clears reasoning", pending: false },
    { waiter: "final", phase: "after final clears reasoning", pending: true },
  ])("reuses the off answer receipt $phase and pending=$pending", async ({ waiter, pending }) => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    const postStarted = Promise.withResolvers<void>();
    let acceptPost!: (value: { messageId: string }) => void;
    sendMessageFeishuMock
      .mockImplementationOnce(() => {
        postStarted.resolve();
        return new Promise((resolve) => {
          acceptPost = resolve;
        });
      })
      .mockResolvedValue({ messageId: "om-reasoning" });
    result.replyOptions.onReasoningStream?.({ text: "Check the team roster." });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    const block = options.deliver({ text: tableMarkdown }, { kind: "block" });
    await postStarted.promise;
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    if (!pending) {
      acceptPost({ messageId: "om-reasoned-answer" });
      await block;
    }
    const idle = waiter === "idle" ? Promise.resolve(options.onIdle?.()) : undefined;
    const final =
      waiter === "final" ? options.deliver({ text: tableMarkdown }, { kind: "final" }) : undefined;
    await requireStreamingInstance(0).discardStarted.promise;
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    if (pending) {
      acceptPost({ messageId: "om-reasoned-answer" });
    }
    const acceptedBlock = await block;
    await idle;
    const acceptedFinal = final
      ? await final
      : await options.deliver({ text: tableMarkdown }, { kind: "final" });
    await options.onIdle?.();
    expect(sendMessageFeishuMock.mock.calls.map(([call]) => call.text)).toEqual(
      waiter === "idle"
        ? [tableMarkdown, "> 💭 **Thinking**  \n> Check the team roster."]
        : [tableMarkdown],
    );
    expect(acceptedFinal).toMatchObject({
      messageIds:
        waiter === "idle" ? ["om-reasoned-answer", "om-reasoning"] : ["om-reasoned-answer"],
      visibleReplySent: true,
    });
    expect(acceptedFinal?.receipt?.parts[0]).toEqual(acceptedBlock?.receipt?.parts[0]);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains the answer receipt when supplemental reasoning fails after an accepted prefix=%s",
    async (acceptedPrefix) => {
      await useRealMarkdownChunker(200);
      const { result, options } = createBlockTableHarness(tableCfg("off"), true);
      sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-accepted-answer" });
      if (acceptedPrefix) {
        sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-reasoning-prefix" });
      }
      sendMessageFeishuMock
        .mockRejectedValueOnce(new Error("reasoning post rejected"))
        .mockResolvedValue({ messageId: "om-unwanted-retry" });
      result.replyOptions.onReasoningStream?.({ text: "Checking the team roster. ".repeat(30) });
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      const idleError: unknown = await Promise.resolve(options.onIdle?.()).catch(
        (error: unknown) => error,
      );
      expect(idleError).toBeInstanceOf(Error);
      const finalError: unknown = await options
        .deliver({ text: tableMarkdown }, { kind: "final" })
        .catch((error: unknown) => error);
      expect(isChannelPartialDeliveryError(finalError)).toBe(true);
      if (!isChannelPartialDeliveryError(finalError)) {
        throw new Error("expected rejected reasoning with the accepted answer receipt");
      }
      expect(finalError.deliveryResult).toMatchObject({
        visibleReplySent: true,
        messageIds: acceptedPrefix
          ? ["om-accepted-answer", "om-reasoning-prefix"]
          : ["om-accepted-answer"],
        content: acceptedPrefix
          ? `${tableMarkdown}\n\n${sendMessageFeishuMock.mock.calls[1]?.[0]?.text}`
          : tableMarkdown,
      });
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(acceptedPrefix ? 3 : 2);
      expect(
        sendMessageFeishuMock.mock.calls.filter(([call]) => call.text.includes("| Ada | Lead |")),
      ).toHaveLength(1);
      await options.onIdle?.();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(acceptedPrefix ? 3 : 2);
    },
  );

  it("preserves reasoning when idle alone posts an off answer", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    result.replyOptions.onReasoningStream?.({ text: "Check the team roster." });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    await options.onIdle?.();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain("> Check the team roster.");
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain(tableMarkdown);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it.each(["idle", "final"] as const)(
    "reuses the posted block receipt when %s settles its matching off preview first",
    async (first) => {
      const { result, options } = createBlockTableHarness();
      sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-block-post" });
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      expect(streamingInstances).toHaveLength(1);
      const block = await options.deliver({ text: tableMarkdown }, { kind: "block" });
      if (first === "idle") {
        await options.onIdle?.();
        expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
      }
      const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
      await options.onIdle?.();
      expect(final).toMatchObject({ messageIds: ["om-block-post"], visibleReplySent: true });
      expect(final?.receipt?.parts).toEqual(block?.receipt?.parts);
      expect(final?.receipt?.platformMessageIds).toEqual(["om-block-post"]);
      expect(final?.receipt?.sentAt).toBe(block?.receipt?.sentAt);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it("waits for the matching block post before settling an idle close and final", async () => {
    const { result, options } = createBlockTableHarness();
    const postStarted = Promise.withResolvers<void>();
    let acceptPost!: (value: { messageId: string }) => void;
    sendMessageFeishuMock.mockImplementationOnce(() => {
      postStarted.resolve();
      return new Promise((resolve) => {
        acceptPost = resolve;
      });
    });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    const block = options.deliver({ text: tableMarkdown }, { kind: "block" });
    await postStarted.promise;
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const idle = Promise.resolve(options.onIdle?.());
    await requireStreamingInstance(0).discardStarted.promise;
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    acceptPost({ messageId: "om-pending-block" });
    await block;
    await idle;
    const settled = (await final?.finalization) ?? final;
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(settled).toMatchObject({
      messageIds: ["om-pending-block"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it.each([
    { waiter: "final", pending: false, receipt: true },
    { waiter: "idle", pending: false, receipt: true },
    { waiter: "final", pending: true, receipt: true },
    { waiter: "idle", pending: true, receipt: true },
    { waiter: "final", pending: true, receipt: false },
    { waiter: "idle", pending: true, receipt: false },
  ])(
    "retains accepted off block chunks for $waiter with pending=$pending and receipt=$receipt",
    async ({ waiter, pending, receipt }) => {
      await useRealMarkdownChunker(200);
      const { result, options } = createBlockTableHarness();
      const text = `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim();
      const postStarted = Promise.withResolvers<void>();
      let rejectChunk!: (error: Error) => void;
      sendMessageFeishuMock
        .mockResolvedValueOnce(receipt ? { messageId: "om-accepted-prefix" } : {})
        .mockImplementationOnce(() => {
          postStarted.resolve();
          return new Promise((_, reject) => {
            rejectChunk = reject;
          });
        })
        .mockResolvedValue({ messageId: "om-unwanted-retry" });
      result.replyOptions.onPartialReply?.({ text });
      expect(streamingInstances).toHaveLength(1);
      const block = options.deliver({ text }, { kind: "block" }).catch((error: unknown) => error);
      await postStarted.promise;
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      if (!pending) {
        rejectChunk(new Error("later chunk rejected"));
        await block;
      }
      const idle =
        waiter === "idle"
          ? Promise.resolve(options.onIdle?.()).catch((error: unknown) => error)
          : undefined;
      const final =
        waiter === "final"
          ? options.deliver({ text }, { kind: "final" }).catch((error: unknown) => error)
          : undefined;
      await requireStreamingInstance(0).discardStarted.promise;
      expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
      if (pending) {
        rejectChunk(new Error("later chunk rejected"));
      }
      const blockError: unknown = await block;
      expect(isChannelPartialDeliveryError(blockError)).toBe(true);
      if (!isChannelPartialDeliveryError(blockError)) {
        throw new Error("expected partial block acceptance");
      }
      const prefix = sendMessageFeishuMock.mock.calls[0]?.[0]?.text;
      expect(prefix).toBeTruthy();
      expect(prefix).not.toBe(text);
      expect(blockError.deliveryResult).toMatchObject({
        ...(receipt ? { messageIds: ["om-accepted-prefix"] } : {}),
        visibleReplySent: true,
        content: prefix,
      });

      if (waiter === "idle") {
        expect(await idle).toBeInstanceOf(Error);
      }
      const finalError: unknown = final
        ? await final
        : await options.deliver({ text }, { kind: "final" }).catch((error: unknown) => error);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      expect(isChannelPartialDeliveryError(finalError)).toBe(true);
      if (!isChannelPartialDeliveryError(finalError)) {
        throw new Error("expected retained partial acceptance");
      }
      expect(finalError.deliveryResult).toMatchObject({
        ...(receipt ? { messageIds: ["om-accepted-prefix"] } : {}),
        visibleReplySent: true,
        content: prefix,
      });
      expect(finalError.deliveryResult.receipt?.parts).toEqual(
        blockError.deliveryResult.receipt?.parts,
      );
      await Promise.resolve(options.onIdle?.()).catch(() => undefined);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    },
  );

  it("preserves a single accepted off block without message_id for its matching final", async () => {
    const { sendMessageFeishu } = await vi.importActual<typeof import("./send.js")>("./send.js");
    const { result, options } = createBlockTableHarness();
    resolveFeishuAccountMock.mockReturnValue({
      ...createReplyAccount("auto", "partial"),
      configured: true,
    });
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValue({ code: 0, data: { message_id: "om-unwanted-retry" } });
    createFeishuClientMock.mockReturnValue({ im: { message: { create: createMessage } } });
    sendMessageFeishuMock.mockImplementation(sendMessageFeishu);
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    const blockError: unknown = await options
      .deliver({ text: tableMarkdown }, { kind: "block" })
      .catch((error: unknown) => error);
    expect(isChannelPartialDeliveryError(blockError)).toBe(true);
    expect(blockError).toMatchObject({
      message: expect.stringContaining("Feishu send failed: no message_id returned"),
      deliveryResult: { visibleReplySent: true, content: tableMarkdown },
    });
    if (!isChannelPartialDeliveryError(blockError)) {
      throw new Error("expected acceptance without a message identifier");
    }
    expect(blockError.deliveryResult.messageIds ?? []).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        uuid: expect.any(String),
        content: buildFeishuPostMessageContent({ messageText: tableMarkdown }),
      },
    });

    const finalError: unknown = await options
      .deliver({ text: tableMarkdown }, { kind: "final" })
      .catch((error: unknown) => error);
    expect({
      attempts: createMessage.mock.calls.length,
      partialFailure: isChannelPartialDeliveryError(finalError),
    }).toEqual({ attempts: 1, partialFailure: true });
    expect(finalError).toMatchObject({
      message: expect.stringContaining("Feishu send failed: no message_id returned"),
      deliveryResult: { visibleReplySent: true, content: tableMarkdown },
    });
    if (!isChannelPartialDeliveryError(finalError)) {
      throw new Error("expected the matching final to retain the failed outcome");
    }
    expect(finalError.deliveryResult.messageIds ?? []).toEqual([]);
    await Promise.resolve(options.onIdle?.()).catch(() => undefined);
    await expect(result.ensureNoVisibleReplyFallback("accepted-no-id-block")).resolves.toBe(false);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it.each(["idle", "final"] as const)(
    "retries a rejected in-flight block when %s is waiting on it",
    async (waiter) => {
      const { result, options } = createBlockTableHarness();
      const postStarted = Promise.withResolvers<void>();
      let rejectPost!: (error: Error) => void;
      sendMessageFeishuMock
        .mockImplementationOnce(() => {
          postStarted.resolve();
          return new Promise((_, reject) => {
            rejectPost = reject;
          });
        })
        .mockResolvedValue({ messageId: "om-retry" });
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      expect(streamingInstances).toHaveLength(1);
      const block = options
        .deliver({ text: tableMarkdown }, { kind: "block" })
        .catch((error: unknown) => error);
      await postStarted.promise;
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      const waiting = (
        waiter === "idle"
          ? Promise.resolve(options.onIdle?.())
          : options.deliver({ text: tableMarkdown }, { kind: "final" })
      ).catch((error: unknown) => error);
      await requireStreamingInstance(0).discardStarted.promise;
      expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
      rejectPost(new Error("pending block unavailable"));
      expect(await block).toBeInstanceOf(Error);
      if (waiter === "idle") {
        expect(await waiting).toBeUndefined();
        expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      }
      const final =
        waiter === "idle"
          ? await options.deliver({ text: tableMarkdown }, { kind: "final" })
          : await waiting;
      expect(final).toMatchObject({ messageIds: ["om-retry"], visibleReplySent: true });
      await options.onIdle?.();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    },
  );

  it("still posts an unmatched table preview after a different block post", async () => {
    const { result, options } = createBlockTableHarness();
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    const otherTable = tableMarkdown.replace("Ada", "Grace");
    await options.deliver({ text: otherTable }, { kind: "block" });
    await options.onIdle?.();
    expect(sendMessageFeishuMock.mock.calls.map(([params]) => params.text)).toEqual([
      otherTable,
      tableMarkdown,
    ]);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("retains an accepted block receipt when a later matching block post fails", async () => {
    const { result, options } = createBlockTableHarness();
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-accepted-block" });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    await options.deliver({ text: tableMarkdown }, { kind: "block" });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("later block unavailable"));
    await expect(options.deliver({ text: tableMarkdown }, { kind: "block" })).rejects.toThrow(
      "later block unavailable",
    );
    await options.onIdle?.();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    expect(final).toMatchObject({
      messageIds: ["om-accepted-block"],
      visibleReplySent: true,
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not count a rejected block post as delivered when idle closes", async () => {
    const { result, options } = createBlockTableHarness();
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("block post unavailable"));
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    await expect(options.deliver({ text: tableMarkdown }, { kind: "block" })).rejects.toThrow(
      "block post unavailable",
    );
    await options.onIdle?.();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toBe(tableMarkdown);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "piped", text: tableMarkdown, earlier: false },
    { shape: "pipeless", text: pipelessTableMarkdown, earlier: false },
    { shape: "piped", text: tableMarkdown, earlier: true },
  ])(
    "recovers a failed idle post for an off $shape table (earlier close: $earlier)",
    async ({ text, earlier }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg("off"),
      });
      if (earlier) {
        result.replyOptions.onPartialReply?.({ text: "Roster ready." });
        await options.onIdle?.();
        expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
      }
      result.replyOptions.onPartialReply?.({ text });
      expect(streamingInstances).toHaveLength(earlier ? 2 : 1);
      const instance = requireStreamingInstance(earlier ? 1 : 0);
      let release!: (closed: StreamingCloseResult) => void;
      instance.discard.mockImplementationOnce(() => {
        instance.discardStarted.resolve();
        return new Promise<StreamingCloseResult>((resolve) => {
          release = resolve;
        });
      });
      sendMessageFeishuMock
        .mockRejectedValueOnce(new Error("post unavailable"))
        .mockResolvedValue({ messageId: "om-recovery-post" });
      const idle = Promise.resolve(options.onIdle?.()).catch((error: unknown) => error);
      await instance.discardStarted.promise;
      expect(instance.discard).toHaveBeenCalledTimes(1);
      instance.active = false;
      const delivery = await options.deliver({ text }, { kind: "final" });
      const finalization = delivery?.finalization;
      release({ visibleReplySent: false, content: "" });
      expect(await idle).toBeInstanceOf(Error);
      const accepted = await finalization;
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toContain("Ada");
      if (earlier) {
        expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toBe(tableMarkdown);
      }
      expect(accepted).toMatchObject({
        messageIds: ["om-recovery-post"],
        visibleReplySent: true,
      });
    },
  );

  it("keeps a partly accepted reasoning-table close as the owner of its matching final", async () => {
    await useRealMarkdownChunker(200);
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    const answer = "Roster ready.";
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-accepted-prefix" })
      .mockRejectedValueOnce(new Error("later chunk rejected"))
      .mockResolvedValue({ messageId: "om-unwanted-resend" });
    result.replyOptions.onReasoningStream?.({
      text: `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim(),
    });
    result.replyOptions.onPartialReply?.({ text: answer });
    expect(streamingInstances).toHaveLength(1);
    const idleError: unknown = await Promise.resolve(options.onIdle?.()).catch(
      (error: unknown) => error,
    );
    expect(isChannelPartialDeliveryError(idleError)).toBe(true);
    const callsAfterIdle = sendMessageFeishuMock.mock.calls.length;
    const lateError: unknown = await options
      .deliver({ text: answer }, { kind: "final" })
      .catch((error: unknown) => error);
    expect(isChannelPartialDeliveryError(lateError)).toBe(true);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(callsAfterIdle);
    expect(streamingInstances).toHaveLength(1);
  });
});
