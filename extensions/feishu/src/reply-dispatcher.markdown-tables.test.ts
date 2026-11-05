import "./reply-dispatcher.tables.test-support.js";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  nativeTableShapes,
  nonTableShapes,
  undrawableTableShapes,
} from "./markdown-table-shapes.test-support.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
} from "./reply-delivery-result.js";
import type { DriveOptions } from "./reply-dispatcher.tables.test-support.js";

const {
  bulletsCard,
  codeText,
  createBlockTableHarness,
  createDispatcherHarness,
  createReplyAccount,
  deliverFinal,
  driveThroughCore,
  getFeishuRuntimeMock,
  installTableDispatcherHarness,
  outgrowingTable,
  pipelessTableMarkdown,
  requireStreamingInstance,
  resolveFeishuAccountMock,
  sendMediaFeishuMock,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  settleWithoutPreviewCard,
  streamingInstances,
  streamingUpdateTexts,
  tableCfg,
  tableMarkdown,
  toTypingDispatcherOptions,
  trackChat,
  useRealMarkdownChunker,
} = await import("./reply-dispatcher.tables.test-support.js");

describe("createFeishuReplyDispatcher markdown table modes", () => {
  installTableDispatcherHarness();
  const bulletsPost = "**Ada**  \n• Role: Lead";
  const fencedCode = "```js\nconst a = 1;\n```\n\n";

  it.each(
    (["off", "bullets", "code", "block"] as const).flatMap((tables) =>
      (["final", "idle"] as const).map((settle) => ({ tables, settle })),
    ),
  )("preserves $tables tables across assistant messages on $settle", async ({ tables, settle }) => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial", "feishu"));
    const { result, options } = createDispatcherHarness({
      accountId: "main",
      cfg: tableCfg(tables),
    });
    expect(result.replyOptions.preserveProgressCallbackStartOrder).toBe(true);
    result.replyOptions.onAssistantMessageStart?.();
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    result.replyOptions.onAssistantMessageStart?.();
    result.replyOptions.onPartialReply?.({ text: "Draft continuation." });
    result.replyOptions.onPartialReply?.({ text: "Corrected continuation." });
    await options.deliver({ text: "Corrected continuation." }, { kind: "block" });
    const delivery =
      settle === "final"
        ? await options.deliver({ text: "Final continuation." }, { kind: "final" })
        : undefined;
    await options.onIdle?.();
    const finalized = await delivery?.finalization;
    const table = tables === "code" ? codeText : tables === "bullets" ? bulletsCard : tableMarkdown;
    const continuation = settle === "final" ? "Final continuation." : "Corrected continuation.";
    const expected = `${table}\n\n${continuation}`;
    const instance = requireStreamingInstance(0);
    if (tables === "off") {
      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(instance.discard).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: expected }),
      );
    } else {
      expect(instance.closeWithResult).toHaveBeenCalledTimes(1);
      expect(instance.closeWithResult).toHaveBeenCalledWith(expected, expect.any(Object));
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    }
    if (settle === "final") {
      expect(finalized ?? delivery).toMatchObject({ visibleReplySent: true, content: expected });
    }
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      tables: "off" as const,
      shape: "piped",
      card: false,
      text: tableMarkdown,
      sent: tableMarkdown,
    },
    {
      tables: "bullets" as const,
      shape: "piped",
      card: false,
      text: tableMarkdown,
      sent: bulletsPost,
    },
    { tables: "code" as const, shape: "piped", card: true, text: tableMarkdown, sent: codeText },
    ...(["block", undefined] as const).flatMap((tables) =>
      [{ shape: "piped", text: tableMarkdown }, ...nativeTableShapes].map(({ shape, text }) => ({
        tables,
        shape,
        card: true,
        text,
        sent: text,
      })),
    ),
  ])("$tables sends a final $shape table (card: $card)", async (row) => {
    await deliverFinal(row.tables, "off", row.text);
    const [used, unused] = row.card
      ? [sendStructuredCardFeishuMock, sendMessageFeishuMock]
      : [sendMessageFeishuMock, sendStructuredCardFeishuMock];
    expect(used).toHaveBeenCalledWith(expect.objectContaining({ text: row.sent }));
    expect(unused).not.toHaveBeenCalled();
  });

  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) => [
      { shape, renderMode: "auto" as const, text: fencedCode + text, posted: fencedCode + posted },
      { shape, renderMode: "card" as const, text, posted },
    ]),
  )(
    "posts a $shape reply table in $renderMode render mode",
    async ({ renderMode, text, posted }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount(renderMode, "off"));
      const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("block") });
      const delivery = await options.deliver({ text }, { kind: "final" });
      await options.onIdle?.();
      await delivery?.finalization;
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: posted }));
    },
  );

  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, posted, tables })),
    ),
  )(
    "$tables posts a $shape table when an open preview closes on idle",
    async ({ tables, text, posted }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg(tables),
      });
      result.replyOptions.onPartialReply?.({ text: "Reading the roster." });
      expect(streamingInstances).toHaveLength(1);
      result.replyOptions.onPartialReply?.({ text: `Reading the roster.\n\n${text}` });
      await options.onIdle?.();
      const instance = requireStreamingInstance(0);
      for (const [shown] of instance.update.mock.calls) {
        expect(String(shown)).not.toContain("Ada");
      }
      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(instance.discard).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: `Reading the roster.\n\n${posted}` }),
      );
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  // A quoted or list-opened `block` table posts the way an `off` table does: opening prose
  // stays on the preview card, the table posts once, and the close posts only the rest.
  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["idle", "final"] as const).map((settle) => [shape, settle, text, posted] as const),
    ),
  )("posts a %s block table once behind opening prose, %s", async (_, settle, table, posted) => {
    createBlockTableHarness(tableCfg("block"));
    const { visible, watch } = trackChat();
    const reader = [{ openId: "ou_reader", name: "Reader", key: "@reader" }];
    const harness = { accountId: "main", cfg: tableCfg("block"), mentionTargets: reader };
    const { result, options } = createDispatcherHarness(harness);
    const parts = ["Here is the roster for the team.", table, "Roster complete."];
    const settled: Promise<{ messageIds?: string[] } | void>[] = [];
    const deliver = async (text: string, kind: "block" | "final") => {
      const delivery = await options.deliver({ text }, { kind });
      settled.push(delivery?.finalization ?? Promise.resolve(delivery));
    };
    for (const [index, text] of parts.entries()) {
      result.replyOptions.onPartialReply?.({ text: parts.slice(0, index + 1).join("\n\n") });
      if (index === 0) {
        watch();
      }
      await deliver(text, "block");
    }
    if (settle === "final") {
      await deliver(parts.join("\n\n"), "final");
    }
    await options.onIdle?.();
    const ids = ["om_stream", "om-1", "om-2"];
    expect(visible().map(({ id, text, mentions }) => [id, text, mentions])).toEqual([
      [ids[0], parts[0], undefined],
      [ids[1], posted, reader],
      [ids[2], parts[2], reader],
    ]);
    const receipts = (await Promise.all(settled)).map((delivered) => delivered?.messageIds);
    expect(receipts).toEqual([ids, ["om-1"], ids, ...(settle === "final" ? [ids] : [])]);
  });

  // A block with no partial of its own right after an assistant-message boundary is the new
  // message's text even when it equals the previewed tail of the message before it, while a block
  // equal to the tail its own message previewed is still the mirror the close posts once.
  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["tail", "table"] as const).map((boundary) => [shape, boundary, text, posted] as const),
    ),
  )(
    "dedupes a %s block tail only within its assistant message, boundary before the %s",
    async (_, boundary, table, posted) => {
      createBlockTableHarness(tableCfg("block"));
      const { visible, watch } = trackChat();
      const reader = [{ openId: "ou_reader", name: "Reader", key: "@reader" }];
      const harness = { accountId: "main", cfg: tableCfg("block"), mentionTargets: reader };
      const { result, options } = createDispatcherHarness(harness);
      const opening = "Reading the roster.";
      const tail = "Roster complete.";
      if (boundary === "table") {
        result.replyOptions.onPartialReply?.({ text: opening });
        result.replyOptions.onAssistantMessageStart?.();
      }
      result.replyOptions.onPartialReply?.({ text: table });
      const post = await options.deliver({ text: table }, { kind: "block" });
      result.replyOptions.onPartialReply?.({ text: `${table}\n\n${tail}` });
      if (boundary === "tail") {
        result.replyOptions.onAssistantMessageStart?.();
      }
      const block = await options.deliver({ text: tail }, { kind: "block" });
      watch();
      await options.onIdle?.();
      // A block without a partial of its own appends as a delta, so the new tail follows the old.
      const chat =
        boundary === "tail"
          ? [
              ["om-1", posted, reader],
              ["om-2", `${tail}${tail}`, reader],
            ]
          : [
              ["om_stream", opening, undefined],
              ["om-1", posted, reader],
              ["om-2", tail, reader],
            ];
      expect(visible().map(({ id, text, mentions }) => [id, text, mentions])).toEqual(chat);
      // A table post under a card that keeps previewed prose settles with the close as well.
      expect(post?.messageIds).toEqual(["om-1"]);
      expect((await post?.finalization)?.messageIds).toEqual(
        boundary === "table" ? chat.map(([id]) => id) : undefined,
      );
      expect((await block?.finalization)?.messageIds).toEqual(chat.map(([id]) => id));
    },
  );

  // What the card closed before the run ended leaves previewed is posted once, whether the preview
  // grows, a later final repeats it, or a new assistant message opens with the same prefix.
  describe.each(undrawableTableShapes)("a late tail after a $shape block table", (shape) => {
    const grace = shape.text.replace("Ada", "Grace");
    const names = {
      P2: "Here is the roster for the team. More prose.",
      P: "Here is the roster for the team.",
      T: shape.text,
      "T#": shape.posted,
      G: grace,
      "G#": shape.postedGrace,
      S: "Roster complete.",
      U: "Attendance confirmed.",
      Q: "And here is the second team.",
    };
    const drive = (tables: "block" | "off", script: string, options?: DriveOptions) =>
      driveThroughCore(tables, names, script, options);
    const early = "preview P; preview P+T; block T";
    const late = `${early}; preview P+T+S; idle`;

    it.each([
      ["a preview that grows", "end"],
      ["a final", "final P+T+S+U; end"],
    ])("posts only what follows the tail for %s", async (_, ending) => {
      expect(await drive("block", `${late}; preview P+T+S+U; ${ending}`)).toMatchObject({
        chat: "om_stream:P om-1:T#@ om-2:S@ om-3:U@",
      });
    });

    it("posts only what follows an off tail an idle closed", async () => {
      expect(await drive("off", `${late}; preview P+T+S+U; end`)).toMatchObject({
        chat: "om_stream:P om-1:T@ om-2:S@ om-3:U@",
      });
    });

    it("names the tail to a final or a block that repeats it", async () => {
      const [final, block] = [
        await drive("block", `${late}; final P+T+S; end`),
        await drive("block", `${late}; block S; end`),
      ];
      expect([final.calls, block.calls]).toEqual([
        "om-1/om_stream,om-1 om_stream,om-1,om-2",
        "om-1/om_stream,om-1 -/om_stream,om-1,om-2",
      ]);
      expect([final.chat, block.chat]).toEqual(Array(2).fill("om_stream:P om-1:T#@ om-2:S@"));
    });

    it("keeps the first chunk a rejected tail accepted when its idle is retried", async () => {
      await useRealMarkdownChunker(120);
      const words = Array.from({ length: 24 }, (_, index) => `word${index}`);
      const [first, rest] = [words.slice(0, 18).join(" "), words.slice(18).join(" ")];
      const run = await drive("block", `${early}; preview P+T+W; idle; end`, {
        rejectPost: 3,
        names: { W: `${first} ${rest}` },
      });
      expect(run.chat).toBe(`om_stream:P om-1:T#@ om-2:${first}@ om-3:${rest}@`);
    });

    it("keeps a first chunk that ends at a soft line break when its idle is retried", async () => {
      await useRealMarkdownChunker(120);
      const words = Array.from({ length: 24 }, (_, index) => `word${index}`);
      const [first, rest] = [words.slice(0, 9).join(" "), words.slice(9).join(" ")];
      // The post writes the break as two spaces and a newline, and the cut falls on that newline.
      const run = await drive("block", `${early}; preview P+T+W; idle; end`, {
        rejectPost: 3,
        names: { W: `${first}\n${rest}` },
      });
      expect(run.chat).toBe(`om_stream:P om-1:T#@ om-2:${first}  @ om-3:${rest}@`);
    });

    it("delivers the sentence after an unmappable converted late chunk on retry", async () => {
      await useRealMarkdownChunker(120);
      const rest =
        "Everyone on the roster has confirmed attendance for the quarterly planning session on Monday morning.";
      const run = await drive("block", `${early}; preview P+T+W; idle; end`, {
        rejectPost: 3,
        names: { W: `${grace}\n\n${rest}` },
      });
      expect(run.chat.split(rest)).toHaveLength(2);
    });

    it("posts a new assistant message with the prefix the settled one had", async () => {
      expect(await drive("block", `${early}; message; preview P+T+S; end`)).toMatchObject({
        chat: "om_stream:P om-1:T#@ om-2:P+T#+S@",
      });
    });

    // Rows: "<tables> <fault> <opening> | <chat order> | <call receipts>".
    it.each([
      "block write P2 | om_stream om-1 oc-1 om-2 om-3 | om-1/om_stream,om-1,oc-1! om-2 -/om_stream,om-1,oc-1,om-2,om-3",
      "block throw P | om_stream om-1 oc-1 om-2 om-3 | om-1/om-1,oc-1! om-2 -/om-1,oc-1,om-2,om-3",
      "off throw P | om_stream om-1 om-2 oc-1 om-3 | om-1 om-2 -/om-1,om-2,oc-1,om-3!",
    ])("lists a recovery card in creation order, %s", async (row) => {
      const [setup = "", order, calls] = row.split(" | ");
      const [tables, fault, open] = setup.split(" ") as [
        "block" | "off",
        "write" | "throw",
        string,
      ];
      const script = `preview P; preview ${open}+T; block T; preview ${open}+T+Q+G; block G; preview ${open}+T+Q+G+S; block S; end`;
      const run = await drive(tables, script, { fault });
      expect([run.chat.match(/(?:om|oc)[-\w]*(?=:)/g)?.join(" "), run.calls]).toEqual([
        order,
        calls,
      ]);
    });

    // Rows: "<tables> <block streaming> <image> <ending> | <call receipts>".
    it.each([
      "block on - idle | om-1/om_stream,om-1,om-2",
      "block on - final | om-1/om_stream,om-1 om_stream,om-1,om-2",
      "block on img idle | om-1,media-1/om_stream,om-1,media-1,om-2",
      "block on img final | om-1,media-1/om_stream,om-1,media-1 om_stream,om-1,media-1,om-2",
      "block off img idle | om-1,media-1/om_stream,om-1,media-1,om-2",
      "block off img final | om-1,media-1/om_stream,om-1,media-1 om_stream,om-1,media-1,om-2",
      "off off img final | om-1,media-1 om_stream,om-1,media-1,om-2",
    ])("settles a captioned table once, %s", async (row) => {
      const [setup = "", calls] = row.split(" | ");
      const [tables, blocks, image, ending] = setup.split(" ") as [
        "block" | "off",
        string,
        string,
        string,
      ];
      const previews = ending === "idle" ? "preview P; preview P+T+S" : "preview P; preview P+T";
      const settle = ending === "idle" ? "" : "preview P+T+S; final P+T+S; ";
      const script = `${previews}; block T${image === "img" ? "@img" : ""}; ${settle}end`;
      const run = await drive(tables, script, { blockStreaming: blocks === "on" });
      const media = image === "img" ? " media-1:https://example.com/roster.png" : "";
      expect(run).toMatchObject({
        chat: `om_stream:P om-1:${tables === "off" ? "T" : "T#"}@${media} om-2:S@`,
        calls,
      });
    });
  });

  // A rejected rewrite of the opening prose leaves the prose the card accepted visible, as the
  // streaming card reports it. That card keeps its place ahead of the table post, and only the
  // card the close recovers for the rewritten prose follows the post, with just the added prose.
  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["idle", "final"] as const).map((settle) => [shape, settle, text, posted] as const),
    ),
  )(
    "keeps an accepted preview card ahead of the %s block table post when its rewrite fails, %s",
    async (_, settle, table, posted) => {
      createBlockTableHarness(tableCfg("block"));
      const { cardEntry, visible, watch } = trackChat();
      const reader = [{ openId: "ou_reader", name: "Reader", key: "@reader" }];
      const harness = { accountId: "main", cfg: tableCfg("block"), mentionTargets: reader };
      const { result, options } = createDispatcherHarness(harness);
      const opening = "Here is the roster for the team.";
      const parts = [`${opening} More prose.`, table, "Roster complete."];
      result.replyOptions.onPartialReply?.({ text: opening });
      watch();
      result.replyOptions.onPartialReply?.({ text: parts.slice(0, 2).join("\n\n") });
      const post = await options.deliver({ text: table }, { kind: "block" });
      result.replyOptions.onPartialReply?.({ text: parts.join("\n\n") });
      requireStreamingInstance().closeWithResult.mockImplementationOnce(async () => {
        cardEntry.text = streamingUpdateTexts().at(-1) ?? "";
        throw createFeishuPartialReplyDeliveryError(new Error("final write rejected"), {
          ...createFeishuReplyDeliveryResult({
            results: [{ messageId: "om_stream" }],
            visibleReplySent: true,
            content: cardEntry.text,
            kind: "card",
          }),
          finalTextAccepted: false,
        });
      });
      const rejected = (error: unknown) =>
        isChannelPartialDeliveryError(error) && error.deliveryResult.messageIds;
      const final =
        settle === "final"
          ? await options.deliver({ text: parts.join("\n\n") }, { kind: "final" }).catch(rejected)
          : undefined;
      const idle = await Promise.resolve(options.onIdle?.()).catch(rejected);
      expect(visible().map(({ id, text, mentions }) => [id, text, mentions])).toEqual([
        ["om_stream", opening, undefined],
        ["om-1", posted, reader],
        ["oc-1", "More prose.", undefined],
        ["om-2", parts[2], reader],
      ]);
      const ids = ["om_stream", "om-1", "oc-1", "om-2"];
      expect(post?.messageIds).toEqual(["om-1"]);
      expect(await post?.finalization?.catch(rejected)).toEqual(ids);
      expect([final, idle]).toEqual([settle === "final" ? ids : undefined, ids]);
    },
  );

  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["block", undefined] as const).flatMap((tables) =>
        (["off", "partial"] as const).map((streaming) => ({
          shape,
          text,
          posted,
          tables,
          streaming,
        })),
      ),
    ),
  )(
    "$tables posts a $shape table as a fenced block with $streaming streaming",
    async ({ tables, text, posted, streaming }) => {
      await deliverFinal(tables, streaming, text);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: posted }));
    },
  );

  it.each(
    nonTableShapes.flatMap(({ shape, text }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
    ),
  )("$tables posts literal rows with $shape", async ({ tables, text }) => {
    await deliverFinal(tables, "off", text);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: text.replace(/(?<!\n)\n(?!\n)/g, "  \n") }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each(["block", undefined] as const)(
    "%s opens a preview for a pipeless block without core block streaming",
    async (tables) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial"));
      const { options } = createDispatcherHarness({ cfg: tableCfg(tables), accountId: "main" });
      await options.deliver({ text: pipelessTableMarkdown }, { kind: "block" });
      expect(streamingInstances).toHaveLength(1);
      expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      await options.onIdle?.();
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
        pipelessTableMarkdown,
        expect.any(Object),
      );
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tables: "bullets", committed: bulletsCard },
    { tables: "block", committed: tableMarkdown },
  ] as const)("commits $tables final text through the streaming card", async (row) => {
    await deliverFinal(row.tables, "partial");
    expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).toBe(row.committed);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  function quoteReasoning(text: string): string {
    return `> \u{1f4ad} **Thinking**\n${text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}`;
  }

  it.each([
    { tables: "code", converted: codeText },
    { tables: "bullets", converted: bulletsCard },
  ] as const)("commits a $tables reasoning table through the streaming card", async (row) => {
    const { result, options } = createBlockTableHarness(tableCfg(row.tables), true);
    result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    result.replyOptions.onPartialReply?.({ text: "Roster ready." });
    expect(streamingInstances).toHaveLength(1);
    await options.onIdle?.();
    const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0];
    expect(committed).toContain(quoteReasoning(row.converted));
    expect(committed).not.toContain(quoteReasoning(tableMarkdown));
    expect(committed).not.toContain("_```_");
  });

  it.each([
    { tables: "code", quoted: false, kept: ["```", "| Ada  | Lead |"] },
    { tables: "block", quoted: false, kept: ["| Ada | Lead |"] },
    { tables: "bullets", quoted: false, kept: ["• Role: Lead"] },
    { tables: "code", quoted: true, kept: ["> ```"] },
    { tables: "bullets", quoted: true, kept: ["> \u2022 Role: Lead"] },
  ] as const)(
    "keeps a delivered $tables reasoning table readable (quoted: $quoted)",
    async ({ tables, quoted, kept }) => {
      const { options } = createBlockTableHarness(tableCfg(tables));
      const table = quoted
        ? tableMarkdown
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        : tableMarkdown;
      await options.deliver(
        { text: `Checking the roster.\n\n${table}`, isReasoning: true },
        { kind: "final" },
      );
      await options.onIdle?.();
      const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
      expect(committed).toContain("_Checking the roster._");
      for (const structural of kept) {
        expect(committed).toContain(structural);
        expect(committed).not.toContain(`_${structural}_`);
      }
    },
  );

  it.each(
    ["```", "~~~"].flatMap((fence) =>
      (["block", "code", "bullets", "off"] as const).flatMap((tables) =>
        [false, true].map((html) => ({ fence, tables, html })),
      ),
    ),
  )(
    "keeps a $fence-fenced table in delivered $tables reasoning as written (html: $html)",
    async (row) => {
      const { options } = createBlockTableHarness(tableCfg(row.tables));
      const sample = `${row.fence}\n${tableMarkdown}\n${row.fence}`;
      const text = row.html ? `<div>\n${sample}\n</div>` : `Checking.\n\n${sample}`;
      await options.deliver({ text, isReasoning: true }, { kind: "final" });
      await options.onIdle?.();
      expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).toBe(
        row.html
          ? `Thinking\n\n_<div>_\n${sample}\n_</div>_`
          : `Thinking\n\n_Checking._\n\n${sample}`,
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(nativeTableShapes)(
    "keeps a delivered $shape reasoning table readable",
    async ({ text }) => {
      const { options } = createBlockTableHarness(tableCfg("block"));
      await options.deliver({ text: `Checking.\n\n${text}`, isReasoning: true }, { kind: "final" });
      await options.onIdle?.();
      const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
      expect(committed).toContain("_Checking._");
      for (const line of text.split(/\r?\n/u)) {
        expect(committed).toContain(line);
        expect(committed).not.toContain(`_${line}_`);
      }
    },
  );

  it.each([`Checking.\n\n${tableMarkdown}`, tableMarkdown])(
    "keeps the card and lists the rows when only block reasoning carries a table (%j)",
    async (reasoning) => {
      const { result, options } = createBlockTableHarness(tableCfg("block"), true);
      await options.onReplyStart?.();
      result.replyOptions.onReasoningStream?.({ text: reasoning });
      result.replyOptions.onPartialReply?.({ text: "Inventory complete." });
      expect(streamingInstances).toHaveLength(1);
      await options.onIdle?.();
      const instance = requireStreamingInstance(0);
      expect(instance.closeWithResult).toHaveBeenCalled();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      const committed = instance.closeWithResult.mock.calls[0]?.[0] ?? "";
      expect(committed).not.toContain(quoteReasoning(tableMarkdown));
      expect(committed).toContain("Ada");
      expect(committed).toContain("Lead");
      expect(committed).not.toContain("| --- |");
      expect(committed).toContain("Inventory complete.");
    },
  );

  it.each([
    { shape: "piped", row: "| r%d | Lead |", head: ["| Name | Role |", "| --- | --- |"] },
    { shape: "pipe-less", row: "r%d | Lead", head: ["Name | Role", "--- | ---"] },
  ])(
    "posts an oversized $shape final rather than splitting it across cards",
    async ({ row, head }) => {
      await useRealMarkdownChunker(200);
      const { options } = createBlockTableHarness(tableCfg("block"));
      const table = [
        ...head,
        ...Array.from({ length: 40 }, (_entry, i) => row.replace("%d", String(i))),
      ].join("\n");
      expect(table.length).toBeGreaterThan(200);
      await options.deliver({ text: table }, { kind: "final" });
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text)).join("");
      expect(posted).toContain("```");
      expect(posted).toContain("Name");
      expect(posted).toContain("r39");
    },
  );

  it("posts a quoted reply table as authored when its fence would not survive the cut", async () => {
    await useRealMarkdownChunker(200);
    const { options } = createBlockTableHarness(tableCfg("block"));
    const quoted = [
      "Roster",
      "",
      ...[
        "| Name | Role |",
        "| --- | --- |",
        ...Array.from({ length: 12 }, (_entry, i) => `| r${i} | Lead |`),
      ].map((line) => `> ${line}`),
    ].join("\n");
    await options.deliver({ text: quoted }, { kind: "final" });
    const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text));
    expect(posted.length).toBeGreaterThan(1);
    for (const message of posted) {
      expect((message.match(/^>?\s*```/gmu) ?? []).length % 2).toBe(0);
    }
    for (const [call] of sendMessageFeishuMock.mock.calls) {
      expect(call.preparedPostText).toBe(true);
    }
    const joined = posted.join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("r11");
  });

  it("shows a streamed block reasoning table as rows the preview can draw", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("block"), true);
    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: `Checking.\n\n${tableMarkdown}` });
    result.replyOptions.onPartialReply?.({ text: "answer part" });
    expect(streamingInstances).toHaveLength(1);
    const instance = requireStreamingInstance(0);
    await instance.updated.promise;
    expect(instance.update).toHaveBeenCalled();
    const shown = String(instance.update.mock.calls.at(-1)?.[0] ?? "");
    expect(shown).toContain("Ada");
    expect(shown).toContain("Lead");
    expect(shown).not.toContain("| Ada | Lead |");
    expect(shown).not.toContain("| --- |");
  });

  it("still delivers final media after a partly rejected matching block", async () => {
    await useRealMarkdownChunker(200);
    const { options } = createBlockTableHarness(tableCfg("off"));
    const text = `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim();
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-accepted-prefix" })
      .mockRejectedValueOnce(new Error("later chunk rejected"))
      .mockResolvedValue({ messageId: "om-later" });
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om-media" });
    const blockError: unknown = await options
      .deliver({ text }, { kind: "block" })
      .catch((error: unknown) => error);
    expect(blockError).toBeInstanceOf(Error);
    const finalError: unknown = await options
      .deliver({ text, mediaUrl: "https://example.com/report.png" }, { kind: "final" })
      .catch((error: unknown) => error);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(finalError).toBeInstanceOf(Error);
    const reported = isChannelPartialDeliveryError(finalError)
      ? finalError.deliveryResult
      : undefined;
    expect(reported?.content).toBeDefined();
    expect(reported?.content).not.toBe(text);
    expect(text.startsWith(reported?.content ?? "")).toBe(true);
  });

  // A final whose tail post is rejected whole after a partly sent fallback card still names
  // every message shown and sends its image. A recovery card partly sent after a failed close
  // is walked past the same way, so the table and the tail still go out after it.
  it.each([
    ["rejected", "final", "rejected", "oc-1:y200 om-1:T@", "oc-1! om-1 oc-1,om-1!"],
    [
      "rejected",
      "final",
      "rejected, image",
      "oc-1:y200 om-1:T@ media-1:I",
      "oc-1! om-1 oc-1,om-1,media-1!",
    ],
    ["backoff", "final", "rejected", "oc-1:y200 om-1:T@", "oc-1! om-1 oc-1,om-1!"],
    [
      "close throws",
      "final",
      "sent",
      "om_stream:P oc-1:y200 om-1:T@ om-2:S@",
      "~oc-1! om-1 oc-1,om-1,om-2!",
    ],
    [
      "close throws",
      "tail",
      "sent",
      "om_stream:P oc-1:y200 om-1:T@ om-2:S@",
      "~oc-1! om-1 ~oc-1,om-1,om-2!",
    ],
  ] as const)(
    "%s start, block prose, %s settles, tail %s",
    async (startup, settle, tail, chat, receipts) => {
      expect(await settleWithoutPreviewCard(startup, "block", settle, tail)).toEqual({
        chat,
        receipts,
      });
    },
  );

  // A final whose tail post is rejected whole names what was shown and sends its image even
  // when every earlier part was accepted whole. Only the close throws that failure bare, for
  // the matching final (the reusable idle rows in reply-dispatcher.block-receipts.test.ts).
  // That includes the close a final runs over preview prose, and a close past a partly sent
  // card, whose tail block is then recovered and named by the final.
  it.each([
    ["rejected", "preview", "final", "rejected", "om-1:P+T@", "om-1 om-1!"],
    [
      "rejected",
      "preview",
      "final",
      "rejected, image",
      "om-1:P+T@ media-1:I",
      "om-1 om-1,media-1!",
    ],
    [
      "ready",
      "preview",
      "final",
      "rejected",
      "om_stream:P om-1:T@ om-2:S@",
      "om-1 om_stream,om-1,om-2",
    ],
    [
      "close throws",
      "block",
      "tail, final",
      "rejected",
      "om_stream:P oc-1:y200 om-1:T@ oc-2:S",
      "~oc-1! om-1 ~oc-2! oc-1,om-1,oc-2!",
    ],
  ] as const)(
    "%s start, %s prose, %s settles, tail %s",
    async (startup, prose, settle, tail, chat, receipts) => {
      expect(await settleWithoutPreviewCard(startup, prose, settle, tail)).toEqual({
        chat,
        receipts,
      });
    },
  );

  it.each([
    { acceptance: "partial", accepted: true },
    { acceptance: "none", accepted: false },
  ])(
    "handles a late final after an idle close post with $acceptance acceptance",
    async ({ accepted }) => {
      await useRealMarkdownChunker(200);
      const { result, options } = createBlockTableHarness(tableCfg("off"));
      const text = `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim();
      if (accepted) {
        sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-accepted-prefix" });
      } else {
        sendMessageFeishuMock.mockRejectedValueOnce(new Error("first chunk rejected"));
      }
      sendMessageFeishuMock
        .mockRejectedValueOnce(new Error("later chunk rejected"))
        .mockResolvedValue({ messageId: "om-later-send" });
      result.replyOptions.onPartialReply?.({ text });
      expect(streamingInstances).toHaveLength(1);
      const idleError: unknown = await Promise.resolve(options.onIdle?.()).catch(
        (error: unknown) => error,
      );
      const callsAfterIdle = sendMessageFeishuMock.mock.calls.length;
      const lateError: unknown = await options
        .deliver({ text }, { kind: "final" })
        .catch((error: unknown) => error);
      if (accepted) {
        expect(isChannelPartialDeliveryError(idleError)).toBe(true);
        expect(sendMessageFeishuMock.mock.calls.length).toBe(callsAfterIdle);
        expect(isChannelPartialDeliveryError(lateError)).toBe(true);
      } else {
        expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(callsAfterIdle);
      }
    },
  );

  it("forwards mentions when an idle close posts a table", async () => {
    const mentions = [{ openId: "ou_target", name: "Target User", key: "@_user_1" }];
    resolveFeishuAccountMock.mockReturnValue({
      ...createReplyAccount("auto", "partial"),
      config: { renderMode: "auto", streaming: { mode: "partial", block: { enabled: true } } },
    });
    const { result, options } = createDispatcherHarness({
      accountId: "main",
      cfg: tableCfg("off"),
      mentionTargets: mentions,
    });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    await options.onIdle?.();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]).toMatchObject({ mentions });
  });

  it("posts an off close whose only table is in streamed reasoning", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    result.replyOptions.onPartialReply?.({ text: "Roster ready." });
    expect(streamingInstances).toHaveLength(1);
    await options.onIdle?.();
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain(quoteReasoning(tableMarkdown));
  });

  it.each([
    { kept: "the answer", update: -1, recovered: [] },
    { kept: "a stale preview", update: -2, recovered: ["Roster ready."] },
  ])("delivers the answer once when a failed off close keeps $kept", async (row) => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    result.replyOptions.onReasoningStream?.({ text: `${tableMarkdown}\n\nRoster ready.` });
    result.replyOptions.onPartialReply?.({ text: "Roster" });
    const delivery = await options.deliver({ text: "Roster ready." }, { kind: "final" });
    const settled = delivery?.finalization?.catch((error: unknown) => error);
    const instance = requireStreamingInstance(0);
    const kept = () => String(instance.update.mock.calls.at(row.update)?.[0]);
    instance.discard.mockImplementationOnce(async () => {
      throw createFeishuPartialReplyDeliveryError(new Error("delete and clear rejected"), {
        ...createFeishuReplyDeliveryResult({
          results: [{ messageId: "om_stream" }],
          visibleReplySent: true,
          content: kept(),
          kind: "card",
        }),
        finalTextAccepted: false,
      });
    });

    await expect(options.onIdle?.()).rejects.toThrow("delete and clear rejected");
    expect(kept()).toContain("Roster ready.");
    const sent = [...sendStructuredCardFeishuMock.mock.calls, ...sendMessageFeishuMock.mock.calls];
    expect(sent.map(([call]) => call.text)).toEqual(row.recovered);
    expect(await settled).toMatchObject({
      deliveryResult: { content: row.recovered[0] ?? kept(), visibleReplySent: true },
    });
  });

  it("re-projects a reasoning table the preview left authored when the close commits", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const outgrows = outgrowingTable;
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);
    const answer = "Here is the summary.";
    expect(convert(answer, "code")).toBe(answer);
    const harness = createBlockTableHarness(tableCfg("code"), true);
    harness.result.replyOptions.onReasoningStream?.({ text: outgrows });
    expect(streamingInstances).toHaveLength(1);
    harness.result.replyOptions.onPartialReply?.({ text: answer });
    await harness.options.onIdle?.();
    const closed = requireStreamingInstance(0);
    const cardBodies = closed.closeWithResult.mock.calls.map((call) => call[0] ?? "");
    expect(cardBodies.filter((body) => body.includes("| row0 |")).length).toBe(0);
    expect([closed.closeWithResult.mock.calls.length, closed.discard.mock.calls.length]).toEqual([
      0, 1,
    ]);
    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.join("")).toContain("| row0 |");
    expect(posts.join("")).not.toContain("\u2022");
  });

  it("resolves the markdown table mode for the named account on post replies", async () => {
    resolveFeishuAccountMock.mockImplementation((params?: { accountId?: string }) => ({
      ...createReplyAccount("auto", "off"),
      accountId: params?.accountId ?? "work",
      config: { renderMode: "raw", streaming: { mode: "off" } },
    }));
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          markdown: { tables: "bullets" },
          accounts: { work: { markdown: { tables: "off" } }, other: {} },
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "feishu", source: "test", plugin: { id: "feishu", meta: { id: "feishu" } } },
      ]),
    );
    try {
      for (const accountId of ["work", "other"]) {
        const { result } = createDispatcherHarness({ accountId, cfg });
        const dispatcher = createReplyDispatcher(toTypingDispatcherOptions(result));
        dispatcher.sendFinalReply({ text: tableMarkdown });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    } finally {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toBe(tableMarkdown);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toBe(bulletsPost);
  });

  it("keeps oversized auto mode markdown final text on the chunked card path", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(24);
    runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["```ts\nx\n```", "tail"]);
    const { options } = createDispatcherHarness({
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```\ntail" }, { kind: "final" });
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(0);
    expect(runtime.channel.text.chunkMarkdownTextWithMode).toHaveBeenCalledTimes(1);
    expect(runtime.channel.text.chunkTextWithMode).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendStructuredCardFeishuMock.mock.calls[0]?.[0]?.text).toBe("```ts\nx\n```");
    expect(sendStructuredCardFeishuMock.mock.calls[1]?.[0]?.text).toBe("tail");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
