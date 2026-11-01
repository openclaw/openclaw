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
  sendMediaFeishuMock,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  streamingInstances,
  tableCfg,
  tableMarkdown,
  toTypingDispatcherOptions,
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
