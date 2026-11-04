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
  sendMediaFeishuMock,
  sendCardFeishuMock,
  sendStructuredCardFeishuMock,
  settleWithoutPreviewCard,
  streamingInstances,
  streamingUpdateTexts,
  tableCfg,
  tableMarkdown,
  trackChat,
  useRealMarkdownChunker,
} = await import("./reply-dispatcher.tables.test-support.js");
const { streamingStartBackoffUntilByAccount } = await import("./reply-dispatcher-state.js");
type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;
const readerMentions = [{ openId: "ou_reader", name: "Reader", key: "@reader" }];
const openingProse = "Here is the roster for the team.";
const tailProse = "Roster complete.";

describe("createFeishuReplyDispatcher block table receipts", () => {
  installTableDispatcherHarness();

  it.each([
    { mode: "off", blocks: 1, settle: "idle", tail: "Roster complete." },
    { mode: "off", blocks: 2, settle: "idle", tail: "Roster complete." },
    { mode: "off", blocks: 2, settle: "final", tail: "Roster complete." },
    { mode: "off", blocks: "2 equal", settle: "final", tail: "Roster complete." },
    { mode: "off", blocks: 1, settle: "idle", tail: "" },
    { mode: "off", blocks: 2, settle: "idle", tail: "" },
    { mode: "off", blocks: 2, settle: "final", tail: "  \n" },
    { mode: "block", blocks: 2, settle: "final", tail: "Roster complete." },
  ] as const)(
    "settles only the remainder of $blocks accepted $mode blocks via $settle with tail=$tail",
    async ({ mode, blocks, settle, tail }) => {
      createBlockTableHarness(tableCfg(mode));
      let nextPostId = 0;
      sendMessageFeishuMock.mockImplementation(async () => ({
        messageId: `om-post-${++nextPostId}`,
      }));
      const mentions = [{ openId: "ou_reader", name: "Reader", key: "@reader" }];
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg(mode),
        mentionTargets: mentions,
        allowReasoningPreview: true,
      });
      const first = mode === "off" ? tableMarkdown : tableMarkdown.replaceAll(/^/gm, "> ");
      const second = blocks === "2 equal" ? first : first.replace("Ada", "Grace");
      const accepted = blocks === 1 ? [first] : [first, second];
      const answer = [...accepted, tail].join("\n\n");
      result.replyOptions.onPartialReply?.({ text: first });
      for (const text of accepted) {
        await options.deliver({ text }, { kind: "block" });
      }
      result.replyOptions.onReasoningStream?.({ text: "Check the team roster." });
      result.replyOptions.onPartialReply?.({ text: answer });
      if (settle === "idle") {
        await options.onIdle?.();
      }
      const delivered = await options.deliver({ text: answer }, { kind: "final" });
      await options.onIdle?.();
      expect(sendMessageFeishuMock.mock.calls.map(([call]) => call.text)).toEqual([
        ...(mode === "off"
          ? accepted
          : [
              "> ```\n> | Name | Role |\n> | ---- | ---- |\n> | Ada  | Lead |\n> ```",
              "> ```\n> | Name  | Role |\n> | ----- | ---- |\n> | Grace | Lead |\n> ```",
            ]),
        ...(tail.trim() ? [tail] : []),
        ...(settle === "idle" ? ["> 💭 **Thinking**  \n> Check the team roster."] : []),
      ]);
      expect(delivered?.messageIds).toEqual(
        Array.from(
          { length: accepted.length + (tail.trim() ? 1 : 0) + (settle === "idle" ? 1 : 0) },
          (_, index) => `om-post-${index + 1}`,
        ),
      );
      if (tail.trim()) {
        expect(sendMessageFeishuMock.mock.calls[accepted.length]?.[0]?.mentions).toEqual(mentions);
      }
      if (settle === "idle") {
        expect(sendMessageFeishuMock.mock.calls.at(-1)?.[0]?.mentions).toBeUndefined();
      }
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rejected: "whole", resent: true, recovered: false },
    { rejected: "whole with a deferred prose block", resent: true, recovered: true },
    { rejected: "after its first chunk", resent: false, recovered: false },
  ])(
    "leaves a remainder rejected $rejected at idle to the matching final, resent=$resent",
    async ({ resent, recovered }) => {
      await useRealMarkdownChunker(200);
      createBlockTableHarness(tableCfg("off"));
      const mentions = [{ openId: "ou_reader", name: "Reader", key: "@reader" }];
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg("off"),
        mentionTargets: mentions,
      });
      const tail = resent ? "Roster complete." : "Roster complete. ".repeat(30).trim();
      sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-block" });
      if (!resent) {
        sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-tail-prefix" });
      }
      sendMessageFeishuMock
        .mockRejectedValueOnce(new Error("remainder rejected"))
        .mockResolvedValue({ messageId: "om-resent" });
      const answer = `${tableMarkdown}\n\n${tail}`;
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "om-recovered" });
      const block = recovered
        ? await options.deliver({ text: tail }, { kind: "block" })
        : undefined;
      const completion = block?.finalization?.catch((error: unknown) => error);
      result.replyOptions.onPartialReply?.({ text: answer });
      const idleError: unknown = await Promise.resolve(options.onIdle?.()).catch(
        (error: unknown) => error,
      );
      expect(idleError).toBeInstanceOf(Error);
      await completion;
      const postsBeforeFinal = sendMessageFeishuMock.mock.calls.map(([call]) => [
        call.text,
        call.mentions,
      ]);
      const final: unknown = await options
        .deliver({ text: answer }, { kind: "final" })
        .catch((error: unknown) => error);
      await Promise.resolve(options.onIdle?.()).catch(() => undefined);
      const posts = sendMessageFeishuMock.mock.calls.map(([call]) => [call.text, call.mentions]);
      expect(posts.filter(([text]) => String(text).includes("| Ada | Lead |"))).toHaveLength(1);
      if (recovered) {
        expect(posts).toEqual([
          [tableMarkdown, mentions],
          [tail, mentions],
        ]);
        expect(posts).toEqual(postsBeforeFinal);
        expect(
          sendStructuredCardFeishuMock.mock.calls.map(([call]) => [call.text, call.mentions]),
        ).toEqual([[tail, undefined]]);
        expect(final).toMatchObject({
          messageIds: ["om-block", "om-recovered"],
          visibleReplySent: true,
        });
      } else if (resent) {
        expect(posts).toEqual([
          [tableMarkdown, mentions],
          [tail, mentions],
          [tail, mentions],
        ]);
        expect(final).toMatchObject({
          messageIds: ["om-block", "om-resent"],
          visibleReplySent: true,
        });
      } else {
        expect(posts).toHaveLength(3);
        expect(isChannelPartialDeliveryError(final)).toBe(true);
        expect(final).toMatchObject({
          deliveryResult: { messageIds: ["om-block", "om-tail-prefix"] },
        });
      }
      await expect(result.ensureNoVisibleReplyFallback("rejected-remainder")).resolves.toBe(false);
      if (!recovered) {
        expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { between: false, settle: "idle", startup: "ready", reasoning: true },
    { between: false, settle: "final", startup: "ready", reasoning: true },
    { between: true, settle: "idle", startup: "ready", reasoning: true },
    { between: true, settle: "final", startup: "ready", reasoning: false },
    { between: false, settle: "idle", startup: "delayed", reasoning: false },
    { between: false, settle: "final", startup: "delayed", reasoning: false },
    { between: false, settle: "final", startup: "rejected", reasoning: false },
    { between: false, settle: "final", startup: "backoff", reasoning: false },
    { between: true, settle: "final", startup: "backoff", reasoning: false },
  ] as const)(
    "settles each part once in reading order, between=$between, $settle, startup=$startup",
    async ({ between, settle, startup, reasoning }) => {
      createBlockTableHarness(tableCfg("off"));
      if (startup === "backoff") {
        streamingStartBackoffUntilByAccount.set("main", Date.now() + 60_000);
      }
      const { gate, watch, visible } = trackChat(startup === "backoff" ? "ready" : startup);
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg("off"),
        mentionTargets: readerMentions,
        allowReasoningPreview: true,
      });
      const second = tableMarkdown.replace("Ada", "Grace");
      const parts = between
        ? [tableMarkdown, openingProse, second, tailProse]
        : [openingProse, tableMarkdown, tailProse];
      const answer = parts.join("\n\n");
      result.replyOptions.onPartialReply?.({ text: parts[0] });
      watch();
      const completions: Promise<unknown>[] = [];
      for (const [index, text] of parts.slice(0, -1).entries()) {
        // A pending startup races the first table block, with the prose only previewed.
        if (startup === "delayed" && index === 0) {
          continue;
        }
        result.replyOptions.onPartialReply?.({ text: parts.slice(0, index + 1).join("\n\n") });
        const pending = options.deliver({ text }, { kind: "block" });
        if (startup === "delayed") {
          // The tail streams while startup is still pending, and the card is created after.
          result.replyOptions.onPartialReply?.({ text: answer });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          gate.resolve();
        }
        const delivery = await pending;
        if (delivery?.finalization) {
          completions.push(delivery.finalization);
        }
      }
      if (reasoning) {
        result.replyOptions.onReasoningStream?.({ text: "Check the team roster." });
      }
      result.replyOptions.onPartialReply?.({ text: answer });
      const thinking = "> 💭 **Thinking**  \n> Check the team roster.";
      const fallback = startup === "rejected" || startup === "backoff";
      const expected = between
        ? [
            [tableMarkdown, readerMentions],
            ...(fallback
              ? [
                  [openingProse, undefined],
                  [second, undefined],
                ]
              : [[openingProse + "\n\n" + second, undefined]]),
            [tailProse, readerMentions],
            ...(reasoning ? [[thinking, undefined]] : []),
          ]
        : fallback
          ? [
              [openingProse, undefined],
              [tableMarkdown, readerMentions],
              [tailProse, readerMentions],
            ]
          : startup === "delayed"
            ? [
                [openingProse + "\n\n" + tableMarkdown, readerMentions],
                [tailProse, readerMentions],
              ]
            : [
                [
                  (reasoning ? "> 💭 **Thinking**\n> Check the team roster.\n\n---\n\n" : "") +
                    openingProse,
                  undefined,
                ],
                [tableMarkdown, readerMentions],
                [tailProse, readerMentions],
              ];
      if (settle === "idle") {
        await options.onIdle?.();
        // Idle settles the whole answer on its own; the final below then adds nothing.
        expect(visible().map((entry) => [entry.text, entry.mentions])).toEqual(expected);
      }
      const final = await options.deliver({ text: answer }, { kind: "final" });
      await options.onIdle?.();
      await Promise.all(completions);
      const seen = visible();
      expect(seen.map((entry) => [entry.text, entry.mentions])).toEqual(expected);
      expect(final?.messageIds).toEqual(seen.map((entry) => entry.id));
      const body = seen.map((entry) => entry.text).join("\n\n");
      let cursor = 0;
      for (const part of parts) {
        expect(body.split(part)).toHaveLength(2);
        const at = body.indexOf(part, cursor);
        expect(at).toBeGreaterThanOrEqual(cursor);
        cursor = at + part.length;
      }
    },
  );

  // Without a preview card a prose block keeps only what its first card took, and prose
  // only previewed rides in the table post. Either way each part is sent once.
  it.each([
    ["rejected", "block", "final", "oc-1:y200 om-1:T@ om-2:S@", "oc-1! om-1 oc-1,om-1,om-2!"],
    ["backoff", "block", "tail", "oc-1:y200 om-1:T@ oc-2:S", "oc-1! om-1 oc-2"],
    ["rejected", "preview", "final", "om-1:P+T@ om-2:S@", "om-1 om-1,om-2"],
  ] as const)("%s start, %s prose, %s once", async (startup, prose, settle, chat, receipts) => {
    expect(await settleWithoutPreviewCard(startup, prose, settle)).toEqual({ chat, receipts });
  });

  it.each([undefined, "settings", "write", "throw"] as const)(
    "delivers the rest once around a prose card close that fails with %s",
    async (fail) => {
      const { createFeishuPartialReplyDeliveryError, createFeishuReplyDeliveryResult } =
        await import("./reply-delivery-result.js");
      createBlockTableHarness(tableCfg("off"));
      const { cardEntry, watch, visible } = trackChat();
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg("off"),
        mentionTargets: readerMentions,
      });
      const parts = [openingProse, tableMarkdown, tailProse];
      const blocks: Promise<unknown>[] = [];
      for (const [index, text] of parts.entries()) {
        result.replyOptions.onPartialReply?.({ text: parts.slice(0, index + 1).join("\n\n") });
        const delivery = await options.deliver({ text }, { kind: "block" });
        blocks.push(Promise.resolve(delivery?.finalization).catch((error: unknown) => error));
      }
      const card = watch()!;
      const close = card.closeWithResult.getMockImplementation()!;
      card.closeWithResult.mockImplementation(async (text, opts) => {
        const stale = streamingUpdateTexts().at(-1) ?? "";
        const closed = await close(text, opts);
        if (fail === "settings") {
          throw createFeishuPartialReplyDeliveryError(new Error(fail), closed);
        }
        if (fail === "write") {
          cardEntry.text = stale;
          throw createFeishuPartialReplyDeliveryError(new Error(fail), {
            ...createFeishuReplyDeliveryResult({
              results: [{ messageId: "om_stream" }],
              visibleReplySent: true,
              content: stale,
              kind: "card",
            }),
            finalTextAccepted: false,
          });
        }
        if (fail === "throw") {
          cardEntry.text = stale;
          throw new Error(fail);
        }
        return closed;
      });
      const idle: unknown = await Promise.resolve(options.onIdle?.()).catch(
        (error: unknown) => error,
      );
      // Core sends no final after streamed blocks; one after a failed close must add nothing.
      const final: unknown = fail
        ? await options
            .deliver({ text: parts.join("\n\n") }, { kind: "final" })
            .catch((error: unknown) => error)
        : undefined;
      const [opening, , closing] = await Promise.all(blocks);
      const stale = fail === "write" || fail === "throw";
      expect(visible().map((entry) => [entry.text, entry.mentions])).toEqual([
        [stale ? streamingUpdateTexts().at(-1) : openingProse, undefined],
        [tableMarkdown, readerMentions],
        ...(fail === "throw" ? [[openingProse, undefined]] : []),
        [tailProse, readerMentions],
      ]);
      // A plain throw leaves the card's own message unnamed; the recovered prose follows the post.
      const ids = fail === "throw" ? ["om-1", "oc-1", "om-2"] : visible().map((entry) => entry.id);
      for (const outcome of fail ? [idle, final, opening, closing] : [opening, closing]) {
        if (fail) {
          expect(isChannelPartialDeliveryError(outcome)).toBe(true);
        }
        expect(outcome).toMatchObject(
          fail ? { deliveryResult: { messageIds: ids } } : { messageIds: ids },
        );
      }
      if (!fail) {
        expect(idle).toBeUndefined();
      }
    },
  );

  it("posts the remainder when retaining opening prose fails to finalize", async () => {
    const { createFeishuPartialReplyDeliveryError, createFeishuReplyDeliveryResult } =
      await import("./reply-delivery-result.js");
    const { result, options } = createBlockTableHarness(tableCfg("off"));
    const prose = "Here is the roster.";
    result.replyOptions.onPartialReply?.({ text: prose });
    const deferred = await options.deliver({ text: prose }, { kind: "block" });
    const completion = deferred?.finalization?.catch((error: unknown) => error);
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-block" })
      .mockResolvedValueOnce({ messageId: "om-done" });
    result.replyOptions.onPartialReply?.({ text: prose + "\n\n" + tableMarkdown });
    await options.deliver({ text: tableMarkdown }, { kind: "block" });
    requireStreamingInstance().closeWithResult.mockImplementationOnce(async (text) => {
      throw createFeishuPartialReplyDeliveryError(
        new Error("card settings rejected"),
        createFeishuReplyDeliveryResult({
          results: [{ messageId: "om_stream" }],
          visibleReplySent: true,
          content: text ?? "",
          kind: "card",
        }),
      );
    });
    const failed: unknown = await options
      .deliver({ text: prose + "\n\n" + tableMarkdown + "\n\nDone." }, { kind: "final" })
      .catch((error: unknown) => error);
    await Promise.resolve(options.onIdle?.()).catch(() => undefined);
    await completion;
    expect(isChannelPartialDeliveryError(failed)).toBe(true);
    expect(failed).toMatchObject({
      deliveryResult: { messageIds: ["om_stream", "om-block", "om-done"] },
    });
    expect(sendMessageFeishuMock.mock.calls.map(([call]) => call.text)).toEqual([
      tableMarkdown,
      "Done.",
    ]);
  });

  it.each(["voice", "presentation"] as const)(
    "still discards opening prose when a %s final replaces it",
    async (kind) => {
      const { result, options } = createBlockTableHarness(tableCfg("off"));
      const prose = "Here is the roster.";
      result.replyOptions.onPartialReply?.({ text: prose });
      const deferred = await options.deliver({ text: prose }, { kind: "block" });
      result.replyOptions.onPartialReply?.({ text: prose + "\n\n" + tableMarkdown });
      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      await options.deliver(
        {
          text: prose + "\n\n" + tableMarkdown,
          ...(kind === "voice"
            ? { mediaUrl: "https://example.com/reply.ogg", audioAsVoice: true }
            : { presentation: { title: "Roster", blocks: [{ type: "text", text: "Ready" }] } }),
        },
        { kind: "final" },
      );
      await options.onIdle?.();
      await deferred?.finalization;
      const card = requireStreamingInstance();
      expect(card.discard).toHaveBeenCalledOnce();
      expect(card.closeWithResult).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock.mock.calls.map(([call]) => call.text)).toEqual([tableMarkdown]);
      expect(kind === "voice" ? sendMediaFeishuMock : sendCardFeishuMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["prose", "reasoning", "reasoning table"] as const)(
    "routes retained %s through a fitting card or posts without replay",
    async (large) => {
      await useRealMarkdownChunker(200);
      const { result, options } = createBlockTableHarness(tableCfg("off"), true);
      const prose = large === "prose" ? "x".repeat(300) : "Here is the roster.";
      const reasoning =
        large === "reasoning"
          ? "z".repeat(300)
          : large === "reasoning table"
            ? tableMarkdown.replace("Ada", "Reasoner")
            : "Check the team roster.";
      let next = 0;
      sendMessageFeishuMock.mockImplementation(async () => ({ messageId: `om-${++next}` }));
      result.replyOptions.onPartialReply?.({ text: prose });
      const deferred = await options.deliver({ text: prose }, { kind: "block" });
      const answer = prose + "\n\n" + tableMarkdown + "\n\nDone.";
      result.replyOptions.onPartialReply?.({ text: prose + "\n\n" + tableMarkdown });
      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      result.replyOptions.onReasoningStream?.({ text: reasoning });
      result.replyOptions.onPartialReply?.({ text: answer });
      await options.onIdle?.();
      const final = await options.deliver({ text: answer }, { kind: "final" });
      await deferred?.finalization;
      const card = requireStreamingInstance();
      const closed = card.closeWithResult.mock.calls.map(([text]) => text ?? "");
      const posts = sendMessageFeishuMock.mock.calls.map(([call]) => call.text);
      expect(closed).toEqual(large !== "prose" ? [prose] : []);
      expect(final?.messageIds).toEqual([
        ...(large !== "prose" ? ["om_stream"] : []),
        ...posts.map((_, i) => `om-${i + 1}`),
      ]);
      const body = [...closed, ...posts].join("\n\n");
      expect(body.split(tableMarkdown)).toHaveLength(2);
      expect(body.split("Done.")).toHaveLength(2);
      expect(body.indexOf(large === "prose" ? "x" : prose)).toBeLessThan(
        body.indexOf(tableMarkdown),
      );
      if (large === "reasoning table") {
        expect(body.split("Reasoner")).toHaveLength(2);
        expect(body.indexOf("Reasoner")).toBeGreaterThan(body.indexOf("Done."));
      } else {
        expect(body.match(large === "prose" ? /x/g : /z/g)).toHaveLength(300);
      }
    },
  );

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
    { waiter: "final", pending: false, receipt: true, growing: false },
    { waiter: "idle", pending: false, receipt: true, growing: false },
    { waiter: "final", pending: true, receipt: true, growing: false },
    { waiter: "idle", pending: true, receipt: true, growing: false },
    { waiter: "final", pending: true, receipt: false, growing: false },
    { waiter: "idle", pending: true, receipt: false, growing: false },
    { waiter: "idle", pending: false, receipt: true, growing: true },
    { waiter: "final", pending: true, receipt: true, growing: true },
  ])(
    "retains accepted off block chunks for $waiter with pending=$pending, receipt=$receipt and growing=$growing",
    async ({ waiter, pending, receipt, growing }) => {
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
      const finalText = growing ? `${text}\n\nRoster complete.` : text;
      result.replyOptions.onPartialReply?.({ text: finalText });
      const idle =
        waiter === "idle"
          ? Promise.resolve(options.onIdle?.()).catch((error: unknown) => error)
          : undefined;
      const final =
        waiter === "final"
          ? options.deliver({ text: finalText }, { kind: "final" }).catch((error: unknown) => error)
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
        : await options
            .deliver({ text: finalText }, { kind: "final" })
            .catch((error: unknown) => error);
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
