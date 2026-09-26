// Feishu tests cover outbound markdown table modes, limits and presentation cards.
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  convertMarkdownTables,
  type MarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
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

vi.mock("./media.js", () => ({
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

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { feishuPlugin } from "./channel.js";
import { feishuOutbound } from "./outbound.js";

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
const cardRenderConfig: ClawdbotConfig = {
  channels: {
    feishu: {
      renderMode: "card",
    },
  },
};

const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
// GFM makes the outer pipes optional, and a fence hides rows that only look like a table.
const pipelessTableMarkdown = "Name | Role\n--- | ---\nAda | Lead";
const nativeTableShapes = [
  { shape: "pipeless", text: pipelessTableMarkdown },
  { shape: "leading-pipe-only", text: "| Name | Role\n| --- | ---\n| Ada | Lead" },
  { shape: "trailing-pipe-only", text: "Name | Role |\n--- | --- |\nAda | Lead |" },
  { shape: "CRLF pipeless", text: pipelessTableMarkdown.replaceAll("\n", "\r\n") },
  { shape: "aligned-delimiter", text: "Name | Role\n:--- | ---:\nAda | Lead" },
] as const;
// Our parser finds a table in these two, but the card renderer does not draw one.
// It does not descend into a blockquote, and it claims the leading list marker
// for a list. Either way the rows would leave the message, so they take the post
// path and arrive as a fenced block instead.
const undrawableTableShapes = [
  {
    shape: "blockquote",
    text: "> Name | Role\n> --- | ---\n> Ada | Lead",
    posted: "> ```\n> | Name | Role |\n> | ---- | ---- |\n> | Ada  | Lead |\n> ```",
  },
  {
    shape: "list-item",
    text: "- Name | Role\n  --- | ---\n  Ada | Lead",
    posted: "```\n| - Name | Role |\n| ------ | ---- |\n| Ada    | Lead |\n```",
  },
] as const;
const nonTableShapes = [
  { shape: "header wider than delimiter", text: "| Name | Role |\n| --- |\n| Ada | Lead |" },
  { shape: "delimiter wider than header", text: "| Name |\n| --- | --- |\n| Ada | Lead |" },
  { shape: "dashless delimiter", text: "| Name | Role |\n| : | : |\n| Ada | Lead |" },
  {
    shape: "blank line before delimiter",
    text: "| Name | Role |\n\n| --- | --- |\n| Ada | Lead |",
  },
] as const;
const fencedTableSample = "```\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n```";
const fencedCodeSample = "```js\nconst value = 1;\n```";

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

function sendMessageCall(index = 0): Record<string, any> | undefined {
  const calls = sendMessageFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendStructuredCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendStructuredCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

describe("feishuOutbound table-limit routing", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  function makeTableText(count: number): string {
    return Array.from({ length: count }, (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`).join(
      "\n\n",
    );
  }

  it("routes 5 markdown tables to structured card when renderMode=auto", async () => {
    const text = makeTableText(5);
    await sendText({ cfg: emptyConfig, to: "chat_1", text, accountId: "main" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to post mode for 6 markdown tables when renderMode=auto", async () => {
    const text = makeTableText(6);
    await sendText({ cfg: emptyConfig, to: "chat_1", text, accountId: "main" });

    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to post mode for 6 tables even with explicit renderMode=card", async () => {
    const text = makeTableText(6);
    await sendText({ cfg: cardRenderConfig, to: "chat_1", text, accountId: "main" });

    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });
});

describe("feishuOutbound presentation card table-limit", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  function makeTableText(count: number): string {
    return Array.from({ length: count }, (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`).join(
      "\n\n",
    );
  }

  function makeActionPresentation(): MessagePresentation {
    return {
      title: "Confirm",
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Confirm", action: { type: "command", command: "/ok" } }],
        },
      ],
    };
  }

  it("refuses the presentation card and falls back to post mode for 6 markdown tables", async () => {
    const text = makeTableText(6);
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text,
      accountId: "main",
      payload: { text, presentation: makeActionPresentation() },
    });

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendMessageCall()?.text).toContain("```");
  });

  it("still builds the presentation card for 5 markdown tables", async () => {
    const text = makeTableText(5);
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text,
      accountId: "main",
      payload: { text, presentation: makeActionPresentation() },
    });

    expect(sendCardFeishuMock).toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});

describe("feishuOutbound.sendText markdown table modes in auto mode", () => {
  const bulletsPost = "**Ada**  \n• Role: Lead";
  const codeCard = convertMarkdownTables(tableMarkdown, "code");

  function tableCfg(scope: "channel" | "account", tables?: MarkdownTableMode): ClawdbotConfig {
    const markdown = tables ? { markdown: { tables } } : {};
    return scope === "channel"
      ? { channels: { feishu: { ...markdown } } }
      : { channels: { feishu: { accounts: { work: { ...markdown } } } } };
  }

  beforeEach(() => {
    resetOutboundMocks();
  });

  describe.each(["raw", "core-rendered"] as const)("presentation via %s payload", (entry) => {
    it.each(
      (["bullets", "code"] as const).flatMap((tables) =>
        (["channel", "named", "defaultAccount"] as const).map((selection) => ({
          tables,
          selection,
        })),
      ),
    )("projects $selection $tables prose, blocks and fallback", async ({ tables, selection }) => {
      const cfg: ClawdbotConfig = {
        channels: {
          feishu: {
            markdown: { tables: selection === "channel" ? tables : "off" },
            ...(selection === "defaultAccount" ? { defaultAccount: "work" } : {}),
            accounts: {
              work: selection !== "channel" ? { markdown: { tables } } : {},
              other: {},
            },
          },
        },
      };
      const presentation: MessagePresentation = {
        blocks: [
          { type: "text", text: tableMarkdown },
          { type: "context", text: tableMarkdown },
          {
            type: "buttons",
            buttons: [{ label: "Continue", action: { type: "command", command: "/continue" } }],
          },
        ],
      };
      let payload: ReplyPayload = { text: tableMarkdown, presentation };
      const ctx = {
        cfg,
        to: "chat_1",
        text: tableMarkdown,
        accountId: selection === "named" ? "work" : undefined,
        payload,
      };
      const converted = convertMarkdownTables(tableMarkdown, tables);
      if (entry === "core-rendered") {
        const rendered = await feishuOutbound.renderPresentation?.({ payload, presentation, ctx });
        expect(rendered).toBeDefined();
        if (!rendered) {
          throw new Error("expected a rendered presentation");
        }
        expect(rendered.text?.split(converted)).toHaveLength(4);
        expect(rendered.text).not.toContain("| --- |");
        const { presentation: _presentation, ...consumed } = rendered;
        payload = consumed;
      }

      await feishuOutbound.sendPayload?.({ ...ctx, text: payload.text ?? "", payload });

      const card = sendCardCall()?.card;
      expect(card).toBeDefined();
      const elements = card.body.elements.filter(
        (element: { tag: string }) => element.tag === "markdown",
      );
      expect(elements.map((element: { content: string }) => element.content)).toEqual([
        converted,
        converted,
        // `code` converts the table to a fence, which cannot survive the color tag.
        tables === "code" ? converted : `<font color='grey'>${converted}</font>`,
      ]);
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    });
  });

  // A presentation the card envelope refuses leaves through the post senders, and those
  // senders stand their conversion down when the cut cannot carry the markers it makes.
  // They can only do that when the prose they receive is the authored one, so the renderer
  // records it beside the converted form and this entry hands that form on.
  it("posts a refused presentation as authored when the cut cannot carry its fences", async () => {
    const cfg = {
      channels: { feishu: { markdown: { tables: "code" }, textChunkLimit: 100 } },
    } as ClawdbotConfig;
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
    // The case only means anything while the conversion carries quoted markers.
    expect(convertMarkdownTables(quotedTable, "code")).toContain("> ```");
    const presentation: MessagePresentation = {
      blocks: [
        { type: "text", text: prose },
        { type: "text", text: quotedTable },
      ],
    };
    let payload: ReplyPayload = { text: "Release summary.", presentation };
    const ctx = { cfg, to: "chat_1", text: payload.text ?? "", accountId: undefined, payload };

    const rendered = await feishuOutbound.renderPresentation?.({ payload, presentation, ctx });
    if (!rendered) {
      throw new Error("expected a rendered presentation");
    }
    const { presentation: _presentation, ...consumed } = rendered;
    payload = consumed;
    await feishuOutbound.sendPayload?.({ ...ctx, text: payload.text ?? "", payload });

    // Guard the fixture: the envelope refused the card, so the posts own the message.
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      // A message opens and closes its own markers or carries none at all.
      expect((post.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    const joined = posts.join("");
    expect(joined).toContain("> | Ada | Lead |");
    expect(joined).toContain("Line 999 of the release report.");
  });

  it("follows defaultAccount when the account id is omitted", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          defaultAccount: "work",
          markdown: { tables: "off" },
          accounts: { work: { markdown: { tables: "bullets" } } },
        },
      },
    };

    await sendText({ cfg, to: "chat_1", text: tableMarkdown });

    expect(sendMessageCall()?.text).toBe(bulletsPost);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("follows the only configured account when the account id is omitted", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          markdown: { tables: "off" },
          accounts: {
            work: {
              appId: "cli_a1",
              appSecret: "local-test-placeholder", // pragma: allowlist secret
              markdown: { tables: "bullets" },
            },
          },
        },
      },
    };

    await sendText({ cfg, to: "chat_1", text: tableMarkdown });

    expect(sendMessageCall()?.text).toBe(bulletsPost);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("off posts the raw table even when renderMode is card", async () => {
    const cfg: ClawdbotConfig = {
      channels: { feishu: { renderMode: "card", markdown: { tables: "off" } } },
    };

    await sendText({ cfg, to: "chat_1", text: tableMarkdown, accountId: "main" });

    expect(sendMessageCall()?.text).toBe(tableMarkdown);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("off posts a pipeless GFM table the card renderer would draw", async () => {
    const cfg: ClawdbotConfig = {
      channels: { feishu: { renderMode: "card", markdown: { tables: "off" } } },
    };

    await sendText({ cfg, to: "chat_1", text: pipelessTableMarkdown, accountId: "main" });

    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  // A card carries a table as one component and the card chunker cuts on lines without
  // repeating the header and its delimiter, so a table that needs more than one card
  // shows raw pipes from the second card on. It takes the post path instead, where the
  // fenced block survives the cut. This branch taught the promotion to read pipe-less
  // tables, which used to miss it and land on the post path anyway.
  it.each([
    { shape: "piped", row: "| r%d | Lead |", head: ["| Name | Role |", "| --- | --- |"] },
    { shape: "pipe-less", row: "r%d | Lead", head: ["Name | Role", "--- | ---"] },
  ])(
    "posts an oversized $shape table instead of splitting it across cards",
    async ({ row, head }) => {
      const table = [
        ...head,
        ...Array.from({ length: 40 }, (_entry, i) => row.replace("%d", String(i))),
      ].join("\n");
      const cfg: ClawdbotConfig = {
        channels: {
          feishu: { accounts: { main: { textChunkLimit: 200, markdown: { tables: "block" } } } },
        },
      };
      // Guard the fixture: one card could not hold it.
      expect(table.length).toBeGreaterThan(200);

      await sendText({ cfg, to: "chat_1", text: table, accountId: "main" });

      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text)).join("");
      // The post path renders it as a fenced block, so the header survives every cut.
      expect(posted).toContain("```");
      expect(posted).toContain("Name");
      expect(posted).toContain("r39");
    },
  );

  // The shared fence scanner reads no quote prefix, so a converted blockquoted table
  // cannot be closed and reopened at a cut and its two markers land in different
  // messages. The table is left as authored there, the way the comment paths leave it.
  it("posts a quoted table as authored when its fence would not survive the cut", async () => {
    const quoted = [
      "Roster",
      "",
      ...[
        "| Name | Role |",
        "| --- | --- |",
        ...Array.from({ length: 12 }, (_e, i) => `| r${i} | Lead |`),
      ].map((line) => `> ${line}`),
    ].join("\n");
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: { accounts: { main: { textChunkLimit: 200, markdown: { tables: "block" } } } },
      },
    };
    // Guard the fixture: converting would put a quote-prefixed marker at each end.
    expect(convertMarkdownTables(quoted, "code")).toContain("> ```");

    await sendText({ cfg, to: "chat_1", text: quoted, accountId: "main" });

    const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text));
    expect(posted.length).toBeGreaterThan(1);
    // No message opens a block another has to close.
    for (const message of posted) {
      expect((message.match(/^>?\s*```/gmu) ?? []).length % 2).toBe(0);
    }
    const joined = posted.join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("r11");
  });

  it("off keeps a fenced table sample on the card path", async () => {
    const cfg: ClawdbotConfig = {
      channels: { feishu: { renderMode: "card", markdown: { tables: "off" } } },
    };

    await sendText({ cfg, to: "chat_1", text: fencedTableSample, accountId: "main" });

    expect(sendStructuredCardCall()?.text).toBe(fencedTableSample);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  describe.each(["channel", "account"] as const)("configured at %s scope", (scope) => {
    const accountId = scope === "account" ? "work" : undefined;

    it("off keeps the raw table on the post path", async () => {
      await sendText({ cfg: tableCfg(scope, "off"), to: "chat_1", text: tableMarkdown, accountId });

      expect(sendMessageCall()?.text).toBe(tableMarkdown);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });

    it("bullets converts on the post path", async () => {
      await sendText({
        cfg: tableCfg(scope, "bullets"),
        to: "chat_1",
        text: tableMarkdown,
        accountId,
      });

      expect(sendMessageCall()?.text).toBe(bulletsPost);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });

    it("code rides a card as a fenced block", async () => {
      await sendText({
        cfg: tableCfg(scope, "code"),
        to: "chat_1",
        text: tableMarkdown,
        accountId,
      });

      expect(codeCard.startsWith("```")).toBe(true);
      expect(sendStructuredCardCall()?.text).toBe(codeCard);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    });

    it.each(
      nativeTableShapes.flatMap(({ shape, text }) =>
        (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
      ),
    )("$tables promotes a $shape native table to a card", async ({ tables, text }) => {
      await sendText({
        cfg: tableCfg(scope, tables),
        to: "chat_1",
        text,
        accountId,
      });

      expect(sendStructuredCardCall()?.text).toBe(text);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    });

    it.each(
      undrawableTableShapes.flatMap(({ shape, text, posted }) =>
        (["block", undefined] as const).map((tables) => ({ shape, text, posted, tables })),
      ),
    )("$tables posts a $shape table as a fenced block", async ({ tables, text, posted }) => {
      await sendText({ cfg: tableCfg(scope, tables), to: "chat_1", text, accountId });

      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageCall()?.text).toBe(posted);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });

    // `shouldUseCard` returns true for a fenced block before it reaches the table
    // count, so without a drawability check here the fence would carry an undrawable
    // table onto a card and the rows would leave the message.
    it.each(
      undrawableTableShapes.flatMap(({ shape, text }) =>
        (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
      ),
    )("$tables posts a $shape table even beside a fence", async ({ tables, text }) => {
      await sendText({
        cfg: tableCfg(scope, tables),
        to: "chat_1",
        text: `${fencedCodeSample}\n\n${text}`,
        accountId,
      });

      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      const posted = sendMessageCall()?.text ?? "";
      expect(posted).toContain("const value = 1;");
      expect(posted).toContain("Ada");
      expect(posted).toContain("Lead");
    });

    it.each(
      nonTableShapes.flatMap(({ shape, text }) =>
        (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
      ),
    )("$tables posts literal rows with $shape", async ({ tables, text }) => {
      await sendText({ cfg: tableCfg(scope, tables), to: "chat_1", text, accountId });

      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      // Posts encode soft line breaks, but retain the literal non-table prose.
      expect(sendMessageCall()?.text).toBe(text.replace(/(?<!\n)\n(?!\n)/g, "  \n"));
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });

    it.each(["block", undefined] as const)(
      "%s keeps the native table on a card",
      async (tables) => {
        await sendText({
          cfg: tableCfg(scope, tables),
          to: "chat_1",
          text: tableMarkdown,
          accountId,
        });

        expect(sendStructuredCardCall()?.text).toBe(tableMarkdown);
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      },
    );
  });

  // Core cuts a reply to its own budget before this channel converts it, and that cut lands on
  // the table. The formatted sender takes the whole text so the conversion runs first and the
  // send chunks for its own target afterwards.
  it("converts a whole table through the formatted text sender", async () => {
    const rows = Array.from(
      { length: 400 },
      (_entry, index) => `| row${index} | detail ${index} |`,
    );
    const table = ["| name | detail |", "| --- | --- |", ...rows].join("\n");
    // The case only means anything while the authored table needs more than one message.
    expect(table.length).toBeGreaterThan(4000);

    const results = await feishuOutbound.sendFormattedText?.({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
      } as ClawdbotConfig,
      to: "chat_1",
      text: table,
      accountId: "main",
    } as never);

    expect(results?.length).toBeGreaterThan(0);
    const delivered = [
      ...sendMessageFeishuMock.mock.calls,
      ...sendStructuredCardFeishuMock.mock.calls,
    ].map((call) => String(call[0]?.text ?? ""));
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
});
