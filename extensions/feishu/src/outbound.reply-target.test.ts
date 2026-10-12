// Feishu tests cover outbound reply-target forwarding and comment delivery.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { renderPresentationForDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import type { FeishuClientCredentials } from "./client.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((_account: FeishuClientCredentials) => ({ request: vi.fn() })),
);
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () =>
    (params: {
      mediaUrl?: string;
      audioAsVoice?: boolean;
      ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
    }) =>
      params.ttsSupplement
        ? params.ttsSupplement.visibleTextAlreadyDelivered === true
        : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return {
      hostname,
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
  };
});

vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  sendMediaFeishu: sendMediaFeishuMock,
  sendStickerFeishu: vi.fn(),
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  resolveFeishuCardTemplate: (template?: string) =>
    new Set([
      "blue",
      "green",
      "red",
      "orange",
      "purple",
      "indigo",
      "wathet",
      "turquoise",
      "yellow",
      "grey",
      "carmine",
      "violet",
      "lime",
    ]).has(template ?? "")
      ? template
      : undefined,
}));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./drive.js")>()),
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./comment-reaction.js")>()),
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { feishuPlugin } from "./channel.js";
import { feishuOutbound } from "./outbound.js";
import { readNativeFeishuCard } from "./presentation-card.js";

type FeishuSendText = NonNullable<typeof feishuOutbound.sendText>;

function requireFeishuSendText(): FeishuSendText {
  const sendText = feishuOutbound.sendText;
  if (!sendText) {
    throw new Error("Expected Feishu outbound sendText");
  }
  return sendText;
}

const sendText = requireFeishuSendText();
const emptyConfig: ClawdbotConfig = {};

const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";

afterAll(() => {
  vi.doUnmock("./media.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./comment-reaction.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

// The shared table-mode resolver reads config only for a registered channel id
// and takes the plugin default from its meta. The harness does not load the
// runtime setup, so register the real plugin for every test.
beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function resetOutboundMocks() {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendCardFeishuMock.mockResolvedValue({ messageId: "native_card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  deliverCommentThreadTextMock.mockResolvedValue({
    delivery_mode: "reply_comment",
    reply_id: "reply_msg",
  });
  cleanupAmbientCommentTypingReactionMock.mockResolvedValue(false);
}

function commentThreadParams(index = 0): Record<string, any> | undefined {
  const calls = deliverCommentThreadTextMock.mock.calls as unknown as Array<
    [unknown, Record<string, any>]
  >;
  return calls[index]?.[1];
}

describe("feishuOutbound.sendText replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("re-chunks a converted comment table at the selected account limit", async () => {
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
      to: "comment:docx:doxcn123:7623358762119646411",
      text: tableMarkdown,
      accountId: "main",
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    // The case only means anything while the source fits the limit and the fence
    // conversion pushes it past, which is the unit the core planner handed over.
    expect(tableMarkdown.length).toBeLessThanOrEqual(50);
    expect(convertMarkdownTables(tableMarkdown, "code").length).toBeGreaterThan(50);
    expect(contents.length).toBeGreaterThan(1);
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(50);
    }
    expect(contents.join("")).toContain("Ada");
    expect(contents.join("")).toContain("Lead");
  });

  // The same is true of the post path, where table projection can turn a message that fit
  // into several sends.
  it("reports only the accepted post text when a later chunk is rejected", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    const text = Array.from({ length: 12 }, (_entry, i) => `line number ${i}`).join("\n");
    // Guard the fixture: the answer is cut into several sends.
    expect(chunking.chunkMarkdownTextWithMode(text, 40, "length").length).toBeGreaterThan(2);
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-1" })
      .mockRejectedValueOnce(new Error("second send rejected"));

    const error: unknown = await sendText({
      cfg: { channels: { feishu: { accounts: { main: { textChunkLimit: 40 } } } } },
      to: "chat_1",
      text,
      accountId: "main",
    }).catch((caught: unknown) => caught);

    const delivered = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    const sent = String(sendMessageFeishuMock.mock.calls[0]?.[0]?.text ?? "");
    expect(delivered?.content).toBe(sent);
    // The authored answer is longer than what reached the peer.
    expect(delivered?.content).not.toBe(text);
  });

  // A partial comment failure owns the text that actually reached the thread. Without it
  // the shared lifecycle falls back to the authored payload and records an answer that
  // was never delivered.
  it("reports only the accepted comment text when a later chunk is rejected", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    const text = Array.from({ length: 12 }, (_entry, i) => `line number ${i}`).join("\n");
    const expected = chunking.chunkMarkdownTextWithMode(text, 40, "length");
    // Guard the fixture: the answer is cut into several comments.
    expect(expected.length).toBeGreaterThan(2);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "om-1" })
      .mockRejectedValueOnce(new Error("second comment rejected"));

    const error: unknown = await sendText({
      cfg: {
        channels: { feishu: { accounts: { main: { textChunkLimit: 40 } } } },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text,
      accountId: "main",
    }).catch((caught: unknown) => caught);

    const delivered = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    expect(delivered?.content).toBe(expected[0]);
    // The authored answer is longer than what reached the thread.
    expect(delivered?.content).not.toBe(text);
  });

  // A cell holding a backtick run the parser cannot pair keeps those characters as text,
  // and the conversion then lengthens the marker to clear them. Ten characters cannot
  // carry the pair this table produces, so the table is left as it arrived. The comments
  // are compared against the chunker itself rather than against a copy of the guard.
  it("leaves a comment table unconverted when a cell lengthens the fence", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    const backtickedTable = "| Name | Role |\n| --- | --- |\n| Ada | ``` |";
    await sendText({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: { textChunkLimit: 10, markdown: { tables: "code" } },
            },
          },
        },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text: backtickedTable,
      accountId: "main",
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    // The case only means anything while the conversion would have grown the marker past
    // the pair a ten-character limit can carry.
    expect(convertMarkdownTables(backtickedTable, "code")).toContain("````");
    expect(contents).toEqual(chunking.chunkMarkdownTextWithMode(backtickedTable, 10, "length"));
  });

  // Core adapts a presentation to the card's text limit before the registered renderer runs, and
  // that cut lands on the authored table, so every fragment after the first stops parsing as one.
  // The projection belongs before that cut, which is where the reply path already puts it.
  it("converts a whole presentation table on the registered outbound path", async () => {
    const rows = Array.from(
      { length: 400 },
      (_entry, index) => `| row${index} | detail ${index} |`,
    );
    const table = ["| name | detail |", "| --- | --- |", ...rows].join("\n");
    // The case only means anything while the authored block outgrows the element limit and core
    // therefore cuts it.
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
    // Every element carrying rows carries the fence that makes them readable.
    for (const content of elements) {
      if (!content.includes("|")) {
        continue;
      }
      expect(content).toContain("```");
    }
    expect(elements.join("")).toContain("row399");
  });

  // A reply with no media went through the shared helper, which cuts the authored text
  // before this channel's send converts it, so only the first fragment kept the header.
  it("converts a whole table when a plain reply carries no media", async () => {
    const rows = Array.from(
      { length: 400 },
      (_entry, index) => `| row${index} | detail ${index} |`,
    );
    const table = ["| name | detail |", "| --- | --- |", ...rows].join("\n");
    // The case only means anything while the authored table needs more than one message.
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
    // Every message carrying rows carries the fence that makes them readable.
    for (const message of delivered) {
      if (!message.includes("|")) {
        continue;
      }
      expect(message).toContain("```");
    }
    expect(delivered.join("")).toContain("row399");
  });

  // A table nested in a list is fenced at the item's own marker, and closed at the column
  // the item's content sits at. Reading neither line as a marker approved a conversion whose
  // opener and closer then reached different comments.
  it("leaves a list-nested comment table unconverted", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    const rows = Array.from({ length: 40 }, (_entry, index) => `    | row${index} | d |`);
    const table = [
      "  - | name | detail |",
      "    | --- | --- |",
      ...rows,
      `    | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    await sendText({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
      } as ClawdbotConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: table,
      accountId: "main",
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    // The case only means anything while the conversion opens at the list marker, closes at
    // the content column, and needs more than one comment to arrive.
    expect(convertMarkdownTables(table, "code")).toContain("  - ```");
    expect(convertMarkdownTables(table, "code")).toContain("\n    ```");
    expect(convertMarkdownTables(table, "code").length).toBeGreaterThan(4000);
    expect(contents).toEqual(chunking.chunkMarkdownTextWithMode(table, 4000, "length"));
  });

  // Indentation before a quote prefix is still a fence's own indentation, and reading the
  // markers as ordinary text approved a conversion whose opener and closer then reached
  // different comments.
  it("leaves an indented quoted comment table unconverted", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    const rows = Array.from({ length: 40 }, (_entry, index) => `   > | row${index} | d |`);
    const table = [
      "   > | name | detail |",
      "   > | --- | --- |",
      ...rows,
      `   > | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    await sendText({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: { markdown: { tables: "code" } },
            },
          },
        },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text: table,
      accountId: "main",
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    // The case only means anything while the conversion carries indented quoted markers and
    // needs more than one comment to arrive.
    expect(convertMarkdownTables(table, "code")).toContain("   > ```");
    expect(convertMarkdownTables(table, "code").length).toBeGreaterThan(4000);
    expect(contents).toEqual(chunking.chunkMarkdownTextWithMode(table, 4000, "length"));
  });

  // A quoted marker inside a top-level block is content, not a closer. Reading it as one
  // left the real closer looking like a second opener, and the comment then arrived as
  // raw rows a comment cannot draw.
  it("converts a comment whose code sample quotes a fence marker", async () => {
    const sample = [
      "| Name | Role |",
      "| --- | --- |",
      "| Ada | Lead |",
      "",
      "```js",
      "const sample = [",
      "> ```",
      "];",
      "```",
    ].join("\n");
    await sendText({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: { markdown: { tables: "code" } },
            },
          },
        },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text: sample,
      accountId: "main",
    });

    const delivered = String(commentThreadParams(0)?.content ?? "");
    // The case only means anything while the sample still quotes a marker inside a block
    // of its own.
    expect(sample).toContain("> ```");
    expect(delivered).toBe(convertMarkdownTables(sample, "code"));
    expect(delivered).toContain("| ---- | ---- |");
  });

  it("chunks a converted comment at the account the request resolves to", async () => {
    await sendText({
      cfg: {
        channels: {
          feishu: {
            defaultAccount: "work",
            accounts: {
              work: { textChunkLimit: 50, markdown: { tables: "code" } },
              other: {},
            },
          },
        },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text: tableMarkdown,
      // No account id, so the limit has to come from the account the resolver picks.
      accountId: undefined,
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    expect(contents.length).toBeGreaterThan(1);
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(50);
    }
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
      to: "comment:docx:doxcn123:7623358762119646411",
      text: tableMarkdown,
      accountId: "main",
      onDeliveryResult,
    });

    const delivered = deliverCommentThreadTextMock.mock.calls.length;
    expect(delivered).toBeGreaterThan(1);
    // One report per physical reply, and a receipt that holds all of them.
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
      to: "comment:docx:doxcn123:7623358762119646411",
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
      // No account id, so the limit has to come from the account the resolver picks,
      // which is the account the table mode a few lines above already reads.
      accountId: undefined,
    });

    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of sendMessageFeishuMock.mock.calls) {
      expect(params.text.length).toBeLessThanOrEqual(10);
    }
  });

  // A tab advances to the next stop of four, so a tab-indented marker is indented code and
  // not a fence. Counting it as one character opened a block nothing closed, and a table that
  // was safe to convert arrived as raw rows instead.
  it("converts a comment table beside a tab-indented sample", async () => {
    const sample = ["\t```", "", "| Name | Role |", "| --- | --- |", "| Ada | Lead |"].join("\n");
    await sendText({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
      } as ClawdbotConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: sample,
      accountId: "main",
    });

    const delivered = String(commentThreadParams(0)?.content ?? "");
    // The case only means anything while the sample still indents its marker with a tab.
    expect(sample).toContain("\t```");
    expect(delivered).toBe(convertMarkdownTables(sample, "code"));
    expect(delivered).toContain("| ---- | ---- |");
  });

  // Four spaces before anything else is indented code, and a quote marker after them does not
  // change that. Reading such a line as a fence opened a block nothing closed, and a table
  // that was safe to convert arrived as raw rows instead.
  it("converts a comment table beside an indented quote sample", async () => {
    const sample = ["    > ```", "", "| Name | Role |", "| --- | --- |", "| Ada | Lead |"].join(
      "\n",
    );
    await sendText({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
      } as ClawdbotConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: sample,
      accountId: "main",
    });

    const delivered = String(commentThreadParams(0)?.content ?? "");
    // The case only means anything while the sample still indents its quote marker past three.
    expect(sample).toContain("    > ");
    expect(delivered).toBe(convertMarkdownTables(sample, "code"));
    expect(delivered).toContain("| ---- | ---- |");
  });

  // A tilde block can hold a sample of backticks, and reading those as a marker of their own
  // left the generated table opener closing a block that was never open, so a safe conversion
  // was refused and the comment arrived as the raw rows a comment cannot draw.
  it("converts a comment whose tilde sample holds backticks", async () => {
    const sample = [
      "~~~",
      "```",
      "~~~",
      "",
      "| Name | Role |",
      "| --- | --- |",
      "| Ada | Lead |",
    ].join("\n");
    await sendText({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
      } as ClawdbotConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: sample,
      accountId: "main",
    });

    const delivered = String(commentThreadParams(0)?.content ?? "");
    // The case only means anything while the sample still holds a marker inside a tilde block.
    expect(sample).toContain("~~~");
    expect(delivered).toBe(convertMarkdownTables(sample, "code"));
    expect(delivered).toContain("| ---- | ---- |");
  });

  // A comment carries no card, and the comment sender converts for its own chunker and
  // keeps the authored form when the markers would not survive the cut. Converting the
  // fallback before it gets there handed it a conversion it could not undo.
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
    const to = "comment:docx:doxcn123:7623358762119646411";
    // The case only means anything while the conversion carries quoted markers and needs
    // more than one comment to arrive.
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

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    expect(contents.length).toBeGreaterThan(0);
    for (const content of contents) {
      // A comment opens and closes its own fences or carries none at all.
      expect((content.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    expect(contents.join("")).toContain("row39");
  });

  // The fanout that separates an attachment from its text used to cut the text into
  // 4,000-character fragments and send each one on its own. That cut lands on the
  // authored table, before the target converts it, so only the first fragment kept the
  // header and the rest arrived as raw pipes. The whole text goes in one call now and the
  // target chunks it after converting.
  it("keeps a long fallback table converted when an attachment splits the send", async () => {
    const table = [
      "| Name | Role |",
      "| --- | --- |",
      ...Array.from(
        { length: 260 },
        (_e, i) => `| person-number-${i} | Regional Operations Lead |`,
      ),
    ].join("\n");
    // Guard the fixture: the authored table is longer than one fanout fragment.
    expect(table.length).toBeGreaterThan(4000);

    await feishuOutbound.sendPayload?.({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "block" } } } } },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text: table,
      accountId: "main",
      payload: { text: table, mediaUrl: "https://example.com/file.png" },
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    // The attachment is its own comment; the rest carry the answer.
    const tableContents = contents.filter((content) => content.includes("person-number-"));
    expect(tableContents.length).toBeGreaterThan(1);
    // Every comment carrying rows also carries the fence, so no continuation arrives as
    // raw pipes the way the pre-conversion cut left them.
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
        to: "comment:docx:doxcn123:7623358762119646411",
        text: tableMarkdown,
        accountId: "main",
      });

      expect(commentThreadParams()?.content).toBe(expected);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );
});

describe("feishuOutbound.sendText receipt-less acceptance", () => {
  // Feishu accepting a send without returning a message id raises a partial-delivery error
  // by design, because an ordinary error would invite a duplicate retry. That text still
  // reached the reader, so the content this reports has to carry it. Reporting only the
  // chunks whose sender returned tells the turn a message it delivered was never sent.
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
      // Length first, so a regression reads as two numbers rather than two walls of x.
      expect(partial.deliveryResult.content?.length).toBe(sent.join("").length);
      expect(partial.deliveryResult.content).toBe(sent.join(""));
      expect(partial.deliveryResult.content?.length).toBeLessThan(authoredText.length);
    },
  );

  // The other direction is worse: a send that genuinely failed must not be reported as
  // delivered text, which is what the catch was added for in the first place.
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
