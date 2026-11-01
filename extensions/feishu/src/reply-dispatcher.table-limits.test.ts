import "./reply-dispatcher.tables.test-support.js";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createFeishuReplyDeliveryResult } from "./reply-delivery-result.js";
import type { FeishuStreamingSession } from "./streaming-card.js";

const {
  bulletsCard,
  codeText,
  createBlockTableHarness,
  createDispatcherHarness,
  createReplyAccount,
  deliverFinal,
  getFeishuRuntimeMock,
  installTableDispatcherHarness,
  outgrowingTable,
  pipelessTableMarkdown,
  requireStreamingInstance,
  resolveFeishuAccountMock,
  sendCardFeishuMock,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  streamingInstances,
  streamingUpdateTexts,
  tableCfg,
  tableMarkdown,
  useRealMarkdownChunker,
} = await import("./reply-dispatcher.tables.test-support.js");
type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;

describe("createFeishuReplyDispatcher table limits and preview budget", () => {
  installTableDispatcherHarness();
  const fencedTableSample = "```\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n```";
  const firstStreamingCloseText = () =>
    String(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]);
  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return value as Record<string, unknown>;
  }
  const approvalPresentation = {
    title: "Plugin bind approval required",
    blocks: [
      { type: "text" as const, text: "Allow Codex to bind this conversation?" },
      {
        type: "buttons" as const,
        buttons: [
          { label: "Allow once", action: { type: "command" as const, command: "/plugin allow" } },
          { label: "Deny", action: { type: "command" as const, command: "/plugin deny" } },
        ],
      },
    ],
  };
  function presentationCardBodies() {
    return sendCardFeishuMock.mock.calls.map(
      (call) => requireRecord(call[0], "native card send").card,
    );
  }

  it.each(
    [
      { shape: "piped", text: tableMarkdown },
      { shape: "pipeless", text: pipelessTableMarkdown },
    ].flatMap(({ shape, text }) =>
      (["final", "block"] as const).map((kind) => ({ shape, text, kind })),
    ),
  )("posts an off $kind carrying a $shape table instead of a streaming card", async (row) => {
    if (row.kind === "final") {
      await deliverFinal("off", "partial", row.text);
    } else {
      const { options } = createBlockTableHarness(tableCfg("off"));
      await options.deliver({ text: row.text }, { kind: "block" });
      await options.onIdle?.();
    }
    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: row.text }));
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps an off block without a table on the streaming card", async () => {
    const { options } = createBlockTableHarness(tableCfg("off"));
    await options.deliver({ text: "plain block" }, { kind: "block" });
    await options.onIdle?.();
    expect(firstStreamingCloseText()).toBe("plain block");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps an off final whose only table is inside a fence on the card path", async () => {
    await deliverFinal("off", "off", fencedTableSample);
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: fencedTableSample }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("discards an open preview when an off final carries a table", async () => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial"));
    const { result, options } = createDispatcherHarness({
      accountId: "main",
      cfg: tableCfg("off"),
    });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    const delivery = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    await options.onIdle?.();
    await delivery?.finalization;
    const instance = requireStreamingInstance(0);
    expect(instance.discard).toHaveBeenCalledTimes(1);
    expect(instance.closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: tableMarkdown }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "piped", text: tableMarkdown },
    { shape: "pipeless", text: pipelessTableMarkdown },
  ])(
    "posts an idle-closed $shape table preview and assigns it to the matching final in off mode",
    async ({ text }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg("off"),
      });
      result.replyOptions.onPartialReply?.({ text });
      expect(streamingInstances).toHaveLength(1);
      const instance = requireStreamingInstance(0);
      let resolveDiscard!: (closed: StreamingCloseResult) => void;
      const discardPromise = new Promise<StreamingCloseResult>((resolve) => {
        resolveDiscard = resolve;
      });
      let resolveClose!: (closed: StreamingCloseResult) => void;
      const closePromise = new Promise<StreamingCloseResult>((resolve) => {
        resolveClose = resolve;
      });
      const closeStarted = Promise.withResolvers<void>();
      instance.discard.mockImplementationOnce(() => {
        closeStarted.resolve();
        return discardPromise;
      });
      instance.closeWithResult.mockImplementationOnce(() => {
        closeStarted.resolve();
        return closePromise;
      });
      sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-table-post" });
      const idle = Promise.resolve(options.onIdle?.());
      await closeStarted.promise;
      expect(instance.discard.mock.calls.length + instance.closeWithResult.mock.calls.length).toBe(
        1,
      );
      instance.active = false;
      const delivery = await options.deliver({ text }, { kind: "final" });
      resolveDiscard({ visibleReplySent: false, content: "" });
      resolveClose(
        createFeishuReplyDeliveryResult({
          results: [{ messageId: "om-table-card" }],
          visibleReplySent: true,
          content: text,
          kind: "card",
        }),
      );
      await idle;
      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain("Ada");
      await expect(delivery?.finalization).resolves.toMatchObject({
        messageIds: ["om-table-post"],
        visibleReplySent: true,
      });
    },
  );

  it.each(["bullets", "code"] as const)(
    "assigns an idle-closed table preview to its matching final in %s mode",
    async (tables) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg(tables),
      });
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      expect(streamingInstances).toHaveLength(1);
      const instance = requireStreamingInstance(0);
      let resolveClose!: (closed: StreamingCloseResult) => void;
      const closePromise = new Promise<StreamingCloseResult>((resolve) => {
        resolveClose = resolve;
      });
      const closeStarted = Promise.withResolvers<void>();
      instance.closeWithResult.mockImplementationOnce(() => {
        closeStarted.resolve();
        return closePromise;
      });
      const idle = Promise.resolve(options.onIdle?.());
      await closeStarted.promise;
      expect(instance.closeWithResult).toHaveBeenCalledTimes(1);
      instance.active = false;
      const committed = String(instance.closeWithResult.mock.calls[0]?.[0]);
      const delivery = await options.deliver({ text: tableMarkdown }, { kind: "final" });
      resolveClose(
        createFeishuReplyDeliveryResult({
          results: [{ messageId: "om-table" }],
          visibleReplySent: true,
          content: committed,
          kind: "card",
        }),
      );
      await idle;
      expect(committed).not.toBe(tableMarkdown);
      await expect(delivery?.finalization).resolves.toMatchObject({
        messageIds: ["om-table"],
        visibleReplySent: true,
      });
      expect(streamingInstances).toHaveLength(1);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  const convertingModes = [
    { tables: "bullets" as const, converted: () => bulletsCard },
    { tables: "code" as const, converted: () => codeText },
  ];

  const reasoningStructureLine = /^\s*(?:```|\||[-*+\u2022]\s|\d+[.)]\s)/u;
  const expectedReasoning = (text: string): string => {
    let insideFence = false;
    return (
      "Thinking\n\n" +
      text
        .split("\n")
        .map((line) => {
          if (/^\s*```/u.test(line)) {
            insideFence = !insideFence;
            return line;
          }
          return insideFence || !line || reasoningStructureLine.test(line) ? line : `_${line}_`;
        })
        .join("\n")
    );
  };

  it("reads the table mode from the account the request resolves to", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {},
      enabled: true,
    });
    const { result } = createDispatcherHarness({
      accountId: undefined,
      cfg: { channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } } },
    });

    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    const instance = requireStreamingInstance(0);
    await instance.updated.promise;
    expect(instance.update).toHaveBeenCalled();
    expect(instance.update.mock.calls.at(-1)?.[0]).toBe(codeText);
  });

  it.each(convertingModes)(
    "projects a $tables table into the card while it is still streaming",
    async ({ tables, converted }) => {
      const { result } = createBlockTableHarness(tableCfg(tables));
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      expect(streamingInstances).toHaveLength(1);
      const instance = requireStreamingInstance(0);
      await instance.updated.promise;
      expect(instance.update).toHaveBeenCalled();
      expect(instance.update.mock.calls.at(-1)?.[0]).toBe(converted());
    },
  );

  it.each(convertingModes)(
    "keeps one $tables table when a cumulative partial follows a block",
    async ({ tables, converted }) => {
      const { result, options } = createBlockTableHarness(tableCfg(tables));
      const delivery = await options.deliver({ text: tableMarkdown }, { kind: "block" });
      result.replyOptions.onPartialReply?.({
        text: `${tableMarkdown}\n\nInventory complete.`,
      });
      await options.onIdle?.();
      await delivery?.finalization;
      expect(firstStreamingCloseText()).toBe(`${converted()}\n\nInventory complete.`);
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      for (const kind of ["block", "final"] as const) {
        const { options: reasoningOptions } = createBlockTableHarness(tableCfg(tables));
        await reasoningOptions.deliver({ text: tableMarkdown, isReasoning: true }, { kind });
        await reasoningOptions.onIdle?.();
        const instance = requireStreamingInstance(kind === "block" ? 1 : 2);
        expect(instance.closeWithResult).toHaveBeenCalledWith(
          expectedReasoning(converted()),
          expect.anything(),
        );
      }
    },
  );

  it.each([
    ...convertingModes.flatMap(({ tables, converted }) => [
      {
        tables,
        after: "the same preview",
        preview: tableMarkdown,
        block: tableMarkdown,
        closed: converted(),
      },
      {
        tables,
        after: "another preview",
        preview: "Intro line.",
        block: `\n\n${tableMarkdown}`,
        closed: `Intro line.\n\n${converted()}`,
      },
      {
        tables,
        after: "no preview",
        preview: undefined,
        block: tableMarkdown,
        closed: converted(),
      },
    ]),
    ...(["block", undefined] as const).map((tables) => ({
      tables,
      after: "the same preview",
      preview: tableMarkdown,
      block: tableMarkdown,
      closed: tableMarkdown,
    })),
  ])("commits one $tables table mirrored from a block after $after", async (row) => {
    const { result, options } = createBlockTableHarness(tableCfg(row.tables));
    if (row.preview !== undefined) {
      result.replyOptions.onPartialReply?.({ text: row.preview });
      expect(streamingInstances).toHaveLength(1);
    }
    await options.deliver({ text: row.block }, { kind: "block" });
    await options.onIdle?.();
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(firstStreamingCloseText()).toBe(row.closed);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  function presentationCardMarkdown(index = 0): string[] {
    const card = requireRecord(presentationCardBodies()[index], "presentation card");
    const body = requireRecord(card.body, "presentation card body");
    const elements = Array.isArray(body.elements) ? body.elements : [];
    return elements
      .filter((element): element is Record<string, unknown> => isRecord(element))
      .filter((element) => element.tag === "markdown")
      .map((element) => String(element.content));
  }

  async function deliverPresentationTable(tables: MarkdownTableMode | undefined) {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off"));
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg(tables) });
    return await options.deliver(
      { text: tableMarkdown, presentation: approvalPresentation },
      { kind: "final" },
    );
  }

  it.each(convertingModes)(
    "converts all $tables presentation prose and its fallback",
    async ({ tables, converted }) => {
      const { options } = createBlockTableHarness(tableCfg(tables));
      const delivery = await options.deliver(
        {
          text: tableMarkdown,
          presentation: {
            blocks: [
              { type: "text", text: tableMarkdown },
              { type: "context", text: tableMarkdown },
              {
                type: "buttons",
                buttons: [{ label: "Continue", action: { type: "command", command: "/continue" } }],
              },
            ],
          },
        },
        { kind: "final" },
      );

      expect(presentationCardMarkdown()).toEqual([
        converted(),
        converted(),
        tables === "code" ? converted() : `<font color='grey'>${converted()}</font>`,
      ]);
      expect(delivery?.content?.split(converted())).toHaveLength(4);
      expect(delivery?.content).not.toContain("| --- |");
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...convertingModes,
    ...(["block", undefined] as const).map((tables) => ({
      tables,
      converted: () => tableMarkdown,
    })),
  ])("carries the $tables table a presentation card shows", async ({ tables, converted }) => {
    const delivery = await deliverPresentationTable(tables);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    const markdown = presentationCardMarkdown();
    expect(markdown[0]).toBe(converted());
    expect(delivery?.content).toContain(converted());
    if (tables === "bullets" || tables === "code") {
      expect(markdown.join("\n")).not.toContain("| --- |");
      expect(delivery?.content).not.toContain("| --- |");
    }
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps off presentation tables literal while retaining controls and authored receipts", async () => {
    const delivery = await deliverPresentationTable("off");
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(presentationCardMarkdown()[0]).toBe(
      "| Name | Role |\n| &#45;-- | --- |\n| Ada | Lead |",
    );
    const serialized = JSON.stringify(presentationCardBodies()[0]);
    expect(serialized).toContain("Allow once");
    expect(serialized).toContain("Deny");
    expect(delivery?.content).toContain(tableMarkdown);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("holds the preview back once the projected answer outgrows the chunk limit", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const fits = tableMarkdown;
    const outgrows = outgrowingTable;
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(fits, "code").length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);
    const fitting = createBlockTableHarness(tableCfg("code"));
    fitting.result.replyOptions.onPartialReply?.({ text: fits });
    expect(streamingInstances).toHaveLength(1);
    await fitting.options.deliver({ text: fits }, { kind: "final" });
    expect(streamingUpdateTexts(0)).toContain(convert(fits, "code"));
    const outgrowing = createBlockTableHarness(tableCfg("code"));
    outgrowing.result.replyOptions.onPartialReply?.({ text: outgrows });
    expect(streamingInstances).toHaveLength(2);
    await outgrowing.options.deliver({ text: outgrows }, { kind: "final" });
    expect(streamingUpdateTexts(1)).toEqual([]);
  });

  it("closes an outgrown projection through a post rather than the card", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const outgrows = outgrowingTable;
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);
    const { result, options } = createBlockTableHarness(tableCfg("code"));
    result.replyOptions.onPartialReply?.({ text: outgrows });
    expect(streamingInstances).toHaveLength(1);
    await options.onIdle?.();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalled();
  });

  it.each(["table", "plain", "authored"] as const)(
    "closes the whole projected body through a post, not the answer half alone (%s)",
    async (answerKind) => {
      await useRealMarkdownChunker();
      const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
      const half = [
        ...Array.from({ length: 250 }, () => "r"),
        "",
        "| name | detail |",
        "| --- | --- |",
        ...Array.from({ length: 20 }, (_entry, index) => `| row${index} | d |`),
        `| wide | ${"w".repeat(100)} |`,
      ].join("\n");
      const reasoning = answerKind === "authored" ? "r".repeat(2_000) : half;
      const answer = { table: half, plain: "p".repeat(2_000), authored: "a".repeat(2_500) }[
        answerKind
      ];
      if (answerKind === "authored") {
        expect(convert(reasoning, "code")).toBe(reasoning);
        expect(convert(answer, "code")).toBe(answer);
        expect(reasoning.length + answer.length).toBeGreaterThan(4000);
      } else {
        expect(half.length * 2 + answer.length).toBeLessThanOrEqual(4000);
        expect(convert(half, "code").length + convert(answer, "code").length).toBeGreaterThan(4000);
      }
      const { result, options } = createBlockTableHarness(tableCfg("code"), true);
      result.replyOptions.onReasoningStream?.({ text: reasoning });
      expect(streamingInstances).toHaveLength(1);
      const streaming = requireStreamingInstance(0);
      await streaming.updated.promise;
      const preview = streamingUpdateTexts(0).join("");
      expect(preview.length).toBeLessThanOrEqual(4000);
      result.replyOptions.onPartialReply?.({ text: answer });
      await options.onIdle?.();
      if (answerKind === "authored") {
        expect(streaming.closeWithResult).toHaveBeenCalledTimes(1);
        expect(streaming.discard).not.toHaveBeenCalled();
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      } else {
        expect(preview).toContain("> ```");
        expect(streaming.closeWithResult).not.toHaveBeenCalled();
        expect(streaming.discard).toHaveBeenCalledTimes(1);
        expect(sendMessageFeishuMock).toHaveBeenCalled();
        const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
        for (const post of posts) {
          expect((post.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
        }
        const recovered = posts.join("");
        expect(recovered).toContain("> r  \n> r");
        expect(recovered).toContain("> | row19 | d |");
        expect(recovered).toContain(`> | wide | ${"w".repeat(100)} |`);
        if (answerKind === "plain") {
          expect(recovered).toContain(answer);
        }
      }
    },
  );

  it("shows reasoning as authored when its conversion outgrows the chunk limit", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const outgrows = outgrowingTable;
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);
    const fitting = createBlockTableHarness(tableCfg("code"), true);
    fitting.result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    expect(streamingInstances).toHaveLength(1);
    await requireStreamingInstance(0).updated.promise;
    expect(streamingUpdateTexts(0).join("")).toContain("> ```");
    const outgrowing = createBlockTableHarness(tableCfg("code"), true);
    outgrowing.result.replyOptions.onReasoningStream?.({ text: outgrows });
    expect(streamingInstances).toHaveLength(2);
    await requireStreamingInstance(1).updated.promise;
    expect(streamingUpdateTexts(1).length).toBeGreaterThan(0);
    const reasoning = streamingUpdateTexts(1).join("");
    expect(reasoning).toContain("| wide |");
    expect(reasoning).not.toContain("```");
  });

  it("reports the text it posted when the conversion gave way to the authored table", async () => {
    await useRealMarkdownChunker();
    resolveFeishuAccountMock.mockReturnValue({
      ...createReplyAccount("auto", "off"),
      config: { renderMode: "raw", streaming: { mode: "off" } },
    });
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const text = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    expect(convert(text, "code")).toContain("> ```");
    expect(convert(text, "code").length).toBeGreaterThan(4000);
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("code") });
    const accepted = await options.deliver({ text }, { kind: "final" });
    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.join("")).toBe(text);
    expect(accepted?.content).toBe(text);
  });

  function forcedPresentationFallback() {
    const runtimeText = getFeishuRuntimeMock().channel.text;
    runtimeText.resolveTextChunkLimit.mockReturnValue(100);
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off"));
    const prose = Array.from(
      { length: 1000 },
      (_entry, index) => `Line ${index} of the release report.`,
    ).join("\n");
    const quotedTable = [
      "> | name | detail |",
      "> | --- | --- |",
      "> | Ada | Lead |",
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("code") });
    return {
      quotedTable,
      lastProseLine: "Line 999 of the release report.",
      quotedRow: "> | Ada | Lead |",
      deliver: async () =>
        await options.deliver(
          {
            text: "Release summary.",
            presentation: {
              blocks: [
                { type: "text", text: prose },
                { type: "text", text: quotedTable },
              ],
            },
          },
          { kind: "final" },
        ),
    };
  }

  it("posts and reports the whole presentation when a refused card forces an unconvertible fallback", async () => {
    await useRealMarkdownChunker();
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const fallback = forcedPresentationFallback();
    expect(convert(fallback.quotedTable, "code")).toContain("> ```");
    const delivery = await fallback.deliver();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    const posted = sendMessageFeishuMock.mock.calls
      .map((call) => String(call[0]?.text ?? ""))
      .join("");
    expect(posted).toContain(fallback.lastProseLine);
    expect(posted).toContain(fallback.quotedRow);
    expect(posted).not.toContain("```");
    expect(delivery?.content).toContain(fallback.quotedRow);
    expect(delivery?.content).toContain(fallback.lastProseLine);
    expect(delivery?.content).not.toContain("```");
  });

  it("keeps a quoted off presentation table literal", async () => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off"));
    const quoted = "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |";
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("off") });
    await options.deliver(
      { presentation: { blocks: [{ type: "text", text: quoted }] } },
      { kind: "final" },
    );

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(presentationCardMarkdown()).toEqual([
      "&gt; | Name | Role |\n&gt; | &#45;-- | --- |\n&gt; | Ada | Lead |",
    ]);
  });

  const half = [
    "| name | detail |",
    "| --- | --- |",
    ...Array.from({ length: 20 }, (_entry, index) => `| row${index} | d |`),
    `| wide | ${"w".repeat(100)} |`,
  ].join("\n");

  it.each(["answer", "reasoning"] as const)(
    "includes a later model wait in the projected %s preview budget",
    async (part) => {
      const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial"));
      const table = half;
      const wait = "Waiting for the local model to respond";
      expect(convert(table, "code").length + wait.length * 50).toBeGreaterThan(4000);
      expect(table.length * 2 + wait.length * 50).toBeLessThan(4000);
      const { result, options } = createDispatcherHarness({
        cfg: tableCfg("code"),
        allowReasoningPreview: true,
      });
      await options.onReplyStart?.();
      if (part === "answer") {
        result.replyOptions.onPartialReply?.({ text: table });
      } else {
        result.replyOptions.onReasoningStream?.({ text: table });
      }
      await result.replyOptions.onItemEvent?.({
        itemId: "model-wait",
        kind: "model-wait",
        phase: "update",
        progressText: wait.repeat(50),
        suppressDurableProgress: true,
      });
      await result.replyOptions.onItemEvent?.({
        itemId: "model-wait",
        kind: "model-wait",
        phase: "end",
        suppressDurableProgress: true,
      });
      await options.onIdle?.();
      const updates = streamingUpdateTexts();
      expect(updates.some((text) => text.includes("```"))).toBe(true);
      const waiting = updates.find((text) => text.includes(wait));
      expect(waiting).toBeDefined();
      expect(updates.filter((text) => text.length > 4000)).toEqual([]);
      expect(waiting).not.toContain("```");
      if (part === "reasoning") {
        expect(waiting).toContain("| wide |");
      }
      expect(updates.at(-1)).toContain("```");
      expect(updates.at(-1)).not.toContain(wait);
      expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).not.toContain(wait);
    },
  );

  it("stands down for every plain partial that would push projected reasoning past the limit", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    expect(convert(half, "code").length + 1_800).toBeGreaterThan(4_000);
    expect(half.length * 2 + 3_000).toBeLessThanOrEqual(4_000);
    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: half });
    expect(streamingInstances).toHaveLength(1);
    for (const length of [600, 1_200, 1_800, 2_400, 3_000]) {
      result.replyOptions.onPartialReply?.({ text: "p".repeat(length) });
    }
    await options.onIdle?.();
    const updates = streamingUpdateTexts(0);
    expect(updates.some((text) => text.includes("p".repeat(600)))).toBe(true);
    expect(updates.filter((text) => text.length > 4_000)).toEqual([]);
  });

  it("still previews an authored body that is past the limit", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: "r".repeat(2_000) });
    result.replyOptions.onPartialReply?.({ text: "a".repeat(2_500) });
    await options.onIdle?.();
    expect(streamingUpdateTexts(0).some((text) => text.length > 4_000)).toBe(true);
  });

  it("starts the next reply on the same dispatcher without the last one's authored reasoning", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: half });
    result.replyOptions.onPartialReply?.({ text: "p".repeat(600) });
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    result.replyOptions.onPartialReply?.({ text: "a".repeat(4_500) });
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(2);
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(1).discard).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
