import "./outbound.tables.test-support.js";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { renderPresentationForDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/markdown-table-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import { feishuOutbound } from "./outbound.js";
import { readNativeFeishuCard } from "./presentation-card.js";

const {
  deliverCommentThreadTextMock,
  installOutboundHarness,
  mockCallArg,
  requireFeishuSendText,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  tableMarkdown,
} = await import("./outbound.tables.test-support.js");

installOutboundHarness();
const sendText = requireFeishuSendText();
const emptyConfig: ClawdbotConfig = {};
const commentTarget = "comment:docx:doxcn123:7623358762119646411";
const commentThreadParams = (index = 0) => mockCallArg(deliverCommentThreadTextMock, index, 1);
const commentContents = () =>
  deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
    String(commentThreadParams(index)?.content ?? ""),
  );
const codeAccountCfg = (main: Record<string, unknown> = {}): ClawdbotConfig => ({
  channels: { feishu: { accounts: { main: { ...main, markdown: { tables: "code" } } } } },
});
const realChunking = () =>
  vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
    "openclaw/plugin-sdk/reply-chunking",
  );

describe("feishuOutbound.sendText replyToId forwarding", () => {
  it.each([
    { selection: "named", accountId: "main" },
    { selection: "defaultAccount", accountId: undefined },
  ])("re-chunks a converted comment table at the $selection account limit", async (row) => {
    const account = { textChunkLimit: 50, markdown: { tables: "code" } };
    await sendText({
      cfg: {
        channels: {
          feishu: {
            ...(row.accountId ? {} : { defaultAccount: "work" }),
            accounts: row.accountId ? { main: account } : { work: account, other: {} },
          },
        },
      } as ClawdbotConfig,
      to: commentTarget,
      text: tableMarkdown,
      accountId: row.accountId,
    });
    const contents = commentContents();
    expect(tableMarkdown.length).toBeLessThanOrEqual(50);
    expect(convertMarkdownTables(tableMarkdown, "code").length).toBeGreaterThan(50);
    expect(contents.length).toBeGreaterThan(1);
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(50);
    }
    expect(contents.join("")).toContain("Ada");
    expect(contents.join("")).toContain("Lead");
  });

  it.each(["chat_1", commentTarget])(
    "reports only the accepted text when a later chunk to %s is rejected",
    async (to) => {
      const text = Array.from({ length: 12 }, (_entry, i) => `line number ${i}`).join("\n");
      const chunks = (await realChunking()).chunkMarkdownTextWithMode(text, 40, "length");
      expect(chunks.length).toBeGreaterThan(2);
      if (to === "chat_1") {
        sendMessageFeishuMock
          .mockResolvedValueOnce({ messageId: "om-1" })
          .mockRejectedValueOnce(new Error("second send rejected"));
      } else {
        deliverCommentThreadTextMock
          .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "om-1" })
          .mockRejectedValueOnce(new Error("second comment rejected"));
      }
      const error: unknown = await sendText({
        cfg: { channels: { feishu: { accounts: { main: { textChunkLimit: 40 } } } } },
        to,
        text,
        accountId: "main",
      }).catch((caught: unknown) => caught);
      const delivered = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
      const first =
        to === "chat_1"
          ? String(mockCallArg(sendMessageFeishuMock)?.text ?? "")
          : commentContents()[0];
      expect(delivered?.content).toBe(first);
      expect(delivered?.content).not.toBe(text);
      if (to !== "chat_1") {
        expect(first).toBe(chunks[0]);
      }
    },
  );

  it.each([
    {
      shape: "a cell that lengthens the fence",
      limit: 10,
      table: "| Name | Role |\n| --- | --- |\n| Ada | ``` |",
      markers: ["````"],
    },
    {
      shape: "a list-nested table",
      limit: 4000,
      table: [
        "  - | name | detail |",
        "    | --- | --- |",
        ...Array.from({ length: 40 }, (_entry, index) => `    | row${index} | d |`),
        `    | wide | ${"w".repeat(220)} |`,
      ].join("\n"),
      markers: ["  - ```", "\n    ```"],
    },
    {
      shape: "an indented quoted table",
      limit: 4000,
      table: [
        "   > | name | detail |",
        "   > | --- | --- |",
        ...Array.from({ length: 40 }, (_entry, index) => `   > | row${index} | d |`),
        `   > | wide | ${"w".repeat(220)} |`,
      ].join("\n"),
      markers: ["   > ```"],
    },
  ])("leaves a comment with $shape unconverted", async ({ limit, table, markers }) => {
    await sendText({
      cfg: codeAccountCfg({ textChunkLimit: limit }),
      to: commentTarget,
      text: table,
      accountId: "main",
    });
    const converted = convertMarkdownTables(table, "code");
    for (const marker of markers) {
      expect(converted).toContain(marker);
    }
    expect(converted.length).toBeGreaterThan(limit);
    expect(commentContents()).toEqual(
      (await realChunking()).chunkMarkdownTextWithMode(table, limit, "length"),
    );
  });

  it("converts a whole presentation table on the registered outbound path", async () => {
    const rows = Array.from(
      { length: 400 },
      (_entry, index) => `| row${index} | detail ${index} |`,
    );
    const table = ["| name | detail |", "| --- | --- |", ...rows].join("\n");
    expect(table.length).toBeGreaterThan(4000);
    const cfg = {
      channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
    } as ClawdbotConfig;
    const payload = { presentation: { blocks: [{ type: "text", text: table }] } } as ReplyPayload;
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: feishuOutbound.presentationCapabilities,
        renderPresentation: async (adapted, sourcePresentation) =>
          await feishuOutbound.renderPresentation!({
            payload: adapted,
            presentation: adapted.presentation,
            sourcePresentation,
            ctx: { cfg, to: "chat_1", text: "", accountId: "main", payload: adapted } as never,
          }),
      },
      payload,
    );

    const elements = (
      (readNativeFeishuCard(rendered)?.body?.elements ?? []) as {
        content?: string;
      }[]
    ).map((element) => element.content ?? "");
    expect(elements.length).toBeGreaterThan(1);
    for (const content of elements) {
      if (!content.includes("|")) {
        continue;
      }
      expect(content).toContain("```");
    }
    expect(elements.join("")).toContain("row399");
  });

  it("converts a whole table when a plain reply carries no media", async () => {
    const rows = Array.from(
      { length: 400 },
      (_entry, index) => `| row${index} | detail ${index} |`,
    );
    const table = ["| name | detail |", "| --- | --- |", ...rows].join("\n");
    expect(table.length).toBeGreaterThan(4000);
    const payload = { text: table };
    await feishuOutbound.sendPayload?.({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
      } as ClawdbotConfig,
      to: "chat_1",
      text: table,
      accountId: "main",
      payload,
    } as never);
    const delivered = [
      ...sendMessageFeishuMock.mock.calls,
      ...sendStructuredCardFeishuMock.mock.calls,
    ]
      .map((call) => String(call[0]?.text ?? ""))
      .filter((text) => text.length > 0);
    expect(delivered.length).toBeGreaterThan(1);
    for (const message of delivered) {
      if (!message.includes("|")) {
        continue;
      }
      expect(message).toContain("```");
    }
    expect(delivered.join("")).toContain("row399");
  });

  it.each([
    {
      sample: "code sample quoting a fence marker",
      marker: "> ```",
      text: [tableMarkdown, "", "```js", "const sample = [", "> ```", "];", "```"].join("\n"),
    },
    { sample: "tab-indented sample", marker: "\t```", text: `\t\`\`\`\n\n${tableMarkdown}` },
    { sample: "indented quote sample", marker: "    > ", text: `    > \`\`\`\n\n${tableMarkdown}` },
    {
      sample: "tilde sample holding backticks",
      marker: "~~~",
      text: `~~~\n\`\`\`\n~~~\n\n${tableMarkdown}`,
    },
  ])("converts a comment table beside a $sample", async ({ marker, text }) => {
    await sendText({ cfg: codeAccountCfg(), to: commentTarget, text, accountId: "main" });
    const delivered = String(commentThreadParams(0)?.content ?? "");
    expect(text).toContain(marker);
    expect(delivered).toBe(convertMarkdownTables(text, "code"));
    expect(delivered).toContain("| ---- | ---- |");
  });

  it("reports every comment chunk it delivers", async () => {
    deliverCommentThreadTextMock.mockReset();
    for (const replyId of ["om-c1", "om-c2", "om-c3", "om-c4"]) {
      deliverCommentThreadTextMock.mockResolvedValueOnce({
        delivery_mode: "reply_comment",
        reply_id: replyId,
      });
    }
    const onDeliveryResult = vi.fn();
    const result = await sendText({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: { textChunkLimit: 50, markdown: { tables: "code" } },
            },
          },
        },
      },
      to: commentTarget,
      text: tableMarkdown,
      accountId: "main",
      onDeliveryResult,
    });

    const delivered = deliverCommentThreadTextMock.mock.calls.length;
    expect(delivered).toBeGreaterThan(1);
    expect(onDeliveryResult).toHaveBeenCalledTimes(delivered);
    const receiptIds = (result as { receipt?: { platformMessageIds?: string[] } }).receipt
      ?.platformMessageIds;
    expect(receiptIds).toHaveLength(delivered);
    expect(receiptIds?.[0]).toBe("om-c1");
  });

  it("keeps a comment that fits in one delivery", async () => {
    await sendText({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: { textChunkLimit: 50, markdown: { tables: "code" } },
            },
          },
        },
      },
      to: commentTarget,
      text: "Looks good to me.",
      accountId: "main",
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledOnce();
    expect(commentThreadParams()?.content).toBe("Looks good to me.");
  });

  it("re-chunks expanded post-md text at the account the request resolves to", async () => {
    await sendText({
      cfg: {
        channels: {
          feishu: {
            defaultAccount: "work",
            accounts: {
              work: { textChunkLimit: 10 },
              other: {},
            },
          },
        },
      },
      to: "chat_1",
      text: Array.from({ length: 10 }, () => "a").join("\n"),
      accountId: undefined,
    });

    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of sendMessageFeishuMock.mock.calls) {
      expect(params.text.length).toBeLessThanOrEqual(10);
    }
  });

  it("keeps a presentation comment readable when its fences cannot survive the cut", async () => {
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const table = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const cfg = {
      channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
    } as ClawdbotConfig;
    const to = commentTarget;
    expect(convertMarkdownTables(table, "code")).toContain("> ```");
    expect(convertMarkdownTables(table, "code").length).toBeGreaterThan(4000);
    const payload = { presentation: { blocks: [{ type: "text", text: table }] } };
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: feishuOutbound.presentationCapabilities,
        renderPresentation: async (adapted, sourcePresentation) =>
          await feishuOutbound.renderPresentation!({
            payload: adapted,
            presentation: adapted.presentation,
            sourcePresentation,
            ctx: { cfg, to, text: "", accountId: "main", payload: adapted } as never,
          }),
      },
      payload as never,
    );
    await sendText({ cfg, to, text: rendered.text ?? "", accountId: "main" });
    const contents = commentContents();
    expect(contents.length).toBeGreaterThan(0);
    for (const content of contents) {
      expect((content.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    expect(contents.join("")).toContain("row39");
  });

  it("keeps a long fallback table converted when an attachment splits the send", async () => {
    const table = [
      "| Name | Role |",
      "| --- | --- |",
      ...Array.from(
        { length: 260 },
        (_e, i) => `| person-number-${i} | Regional Operations Lead |`,
      ),
    ].join("\n");
    expect(table.length).toBeGreaterThan(4000);
    await feishuOutbound.sendPayload?.({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "block" } } } } },
      },
      to: commentTarget,
      text: table,
      accountId: "main",
      payload: { text: table, mediaUrl: "https://example.com/file.png" },
    });

    const contents = commentContents();
    const tableContents = contents.filter((content) => content.includes("person-number-"));
    expect(tableContents.length).toBeGreaterThan(1);
    for (const content of tableContents) {
      expect(content).toContain("```");
    }
    const joined = contents.join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("person-number-259");
  });

  it.each([
    ["bullets", convertMarkdownTables(tableMarkdown, "bullets")],
    ["code", convertMarkdownTables(tableMarkdown, "code")],
    [undefined, convertMarkdownTables(tableMarkdown, "code")],
    ["off", tableMarkdown],
  ] as const)(
    "converts a table for a document-comment target in %s mode",
    async (tables, expected) => {
      const cfg: ClawdbotConfig = tables ? { channels: { feishu: { markdown: { tables } } } } : {};
      await sendText({
        cfg,
        to: commentTarget,
        text: tableMarkdown,
        accountId: "main",
      });

      expect(commentThreadParams()?.content).toBe(expected);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );
});

describe("feishuOutbound.sendText receipt-less acceptance", () => {
  it.each([1, 2])(
    "reports accepted chunk %i without a receipt as delivered content",
    async (receiptLessChunk) => {
      const sent: string[] = [];
      const authoredText = "x".repeat(9_000);
      sendMessageFeishuMock.mockImplementation(async ({ text }: { text: string }) => {
        sent.push(text);
        if (sent.length < receiptLessChunk) {
          return { messageId: "chunk_1", chatId: "chat_1" };
        }
        throw createChannelPartialDeliveryError(
          new Error("Feishu send failed: no message_id returned"),
          { messageIds: [], visibleReplySent: true },
        );
      });

      let caught: unknown;
      try {
        await feishuOutbound.sendText?.({
          cfg: emptyConfig,
          to: "chat_1",
          accountId: "main",
          text: authoredText,
        } as never);
      } catch (err) {
        caught = err;
      }
      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      const partial = caught as ReturnType<typeof createChannelPartialDeliveryError>;
      expect(sent.length).toBe(receiptLessChunk);
      expect(partial.deliveryResult.messageIds).toEqual(receiptLessChunk === 1 ? [] : ["chunk_1"]);
      expect(partial.deliveryResult.content?.length).toBe(sent.join("").length);
      expect(partial.deliveryResult.content).toBe(sent.join(""));
      expect(partial.deliveryResult.content?.length).toBeLessThan(authoredText.length);
    },
  );

  it("leaves a chunk out of delivered content when its send genuinely failed", async () => {
    const sent: string[] = [];
    sendMessageFeishuMock.mockImplementation(async ({ text }: { text: string }) => {
      sent.push(text);
      if (sent.length === 1) {
        return { messageId: "chunk_1", chatId: "chat_1" };
      }
      throw new Error("second chunk failed");
    });

    let caught: unknown;
    try {
      await feishuOutbound.sendText?.({
        cfg: emptyConfig,
        to: "chat_1",
        accountId: "main",
        text: "x".repeat(5_000),
      } as never);
    } catch (err) {
      caught = err;
    }
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    const partial = caught as ReturnType<typeof createChannelPartialDeliveryError>;
    expect(sent.length).toBe(2);
    expect(partial.deliveryResult.content?.length).toBe(sent[0]?.length);
    expect(partial.deliveryResult.content).toBe(sent[0]);
  });
});
