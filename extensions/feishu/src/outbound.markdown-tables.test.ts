import "./outbound.tables.test-support.js";
import {
  renderPresentationForDelivery,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  convertMarkdownTables,
  type MarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import {
  buildFeishuActionPresentationCard,
  deliverableFeishuActionCard,
} from "./action-presentation-card.js";
import {
  nativeTableShapes,
  nonTableShapes,
  pipelessTableMarkdown,
  undrawableTableShapes,
} from "./markdown-table-shapes.test-support.js";
import { feishuOutbound, presentationTableMode } from "./outbound.js";
import {
  feishuCardWithinTableLimit,
  hasCardMarkdownTable,
  isFeishuCardWithinEnvelope,
} from "./presentation-card.js";

const {
  installOutboundHarness,
  mockCallArg,
  requireFeishuSendText,
  sendCardFeishuMock,
  sendMessageFeishuMock,
  sendStructuredCardFeishuMock,
  tableMarkdown,
} = await import("./outbound.tables.test-support.js");

installOutboundHarness();
const sendText = requireFeishuSendText();
const sendMessageCall = (index = 0) => mockCallArg(sendMessageFeishuMock, index);
const sendCardCall = (index = 0) => mockCallArg(sendCardFeishuMock, index);
const emptyConfig: ClawdbotConfig = {};
const cardRenderConfig: ClawdbotConfig = { channels: { feishu: { renderMode: "card" } } };
const fencedTableSample = "```\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n```";
const fencedCodeSample = "```js\nconst value = 1;\n```";
function expectDeliverableWithControls(card: Record<string, any> | undefined) {
  expect(card && isFeishuCardWithinEnvelope(card)).toBe(true);
  expect(card && feishuCardWithinTableLimit(card)).toBe(true);
  expect(card?.body.elements.some((element: { tag: string }) => element.tag === "button")).toBe(
    true,
  );
}

describe("feishuOutbound table-limit routing", () => {
  function tableText(count: number) {
    return Array.from({ length: count }, (_, i) => "| a" + i + " | b |\n| - | - |\n| 1 | 2 |").join(
      "\n\n",
    );
  }

  it("keeps card text intact and strips prose from identity emoji in threaded headers", async () => {
    const text = "| a | b |\n| - | - |";
    const result = await sendText({
      cfg: cardRenderConfig,
      to: "chat_1",
      accountId: "main",
      text,
      threadId: "om_topic",
      identity: { name: "Agent", emoji: "根据心情/语气自由切换 😊🇺🇸👍🏽👨‍👩‍👧‍👦" },
    });
    expect(sendStructuredCardFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      text,
      replyToMessageId: "om_topic",
      replyInThread: true,
      header: { title: "😊🇺🇸👍🏽👨‍👩‍👧‍👦 Agent", template: "blue" },
    });
    expect(result).toMatchObject({ channel: "feishu", messageId: "card_msg" });
  });

  it("falls back to post mode above five markdown tables even in card mode", async () => {
    await sendText({ cfg: cardRenderConfig, to: "chat_1", accountId: "main", text: tableText(6) });
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("refuses a presentation card above five markdown tables", async () => {
    const text = tableText(6);
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      accountId: "main",
      text,
      payload: {
        text,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Confirm", action: { type: "command", command: "/ok" } }],
            },
          ],
        },
      },
    });
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendMessageCall()?.text).toContain("`".repeat(3));
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
        tables === "code" ? converted : `<font color='grey'>${converted}</font>`,
      ]);
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    });
  });

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
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect((post.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    const joined = posts.join("");
    expect(joined).toContain("> | Ada | Lead |");
    expect(joined).toContain("Line 999 of the release report.");
  });

  it("keeps a quoted table off the card path when its fences cannot survive the cut", async () => {
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const table = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    expect(convertMarkdownTables(table, "code")).toContain("> ```");
    expect(convertMarkdownTables(table, "code").length).toBeGreaterThan(4000);
    await sendText({
      cfg: {
        channels: {
          feishu: {
            renderMode: "card",
            accounts: { main: { markdown: { tables: "code" } } },
          },
        },
      } as ClawdbotConfig,
      to: "chat_1",
      text: table,
      accountId: "main",
    });

    const delivered = [
      ...sendStructuredCardFeishuMock.mock.calls,
      ...sendMessageFeishuMock.mock.calls,
    ].map((call) => String(call[0]?.text ?? ""));
    expect(delivered.length).toBeGreaterThan(0);
    for (const message of delivered) {
      expect((message.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    expect(delivered.join("")).toContain("row39");
  });

  it.each(
    (["action", "raw", "core-rendered"] as const).flatMap((entry) =>
      (["default", "off"] as const).map((tables) => ({ entry, tables })),
    ),
  )("keeps every row of a long $entry presentation table readable ($tables)", async (params) => {
    const cfg: ClawdbotConfig =
      params.tables === "off" ? { channels: { feishu: { markdown: { tables: "off" } } } } : {};
    const names = Array.from({ length: 200 }, (_entry, index) => `person-number-${index}`);
    const rows = names.map((name) => `| ${name} | Regional Operations Lead |`);
    const text = ["Roster.", "", "| Name | Role |", "| --- | --- |", ...rows, "", "End."].join(
      "\n",
    );
    expect(presentationTableMode({ cfg: emptyConfig })).toBe("block");
    expect(text.length).toBeGreaterThan(8000);
    const presentation: MessagePresentation = {
      blocks: [
        { type: "text", text },
        {
          type: "buttons",
          buttons: [{ label: "Ok", action: { type: "command", command: "/ok" } }],
        },
      ],
    };
    let card =
      params.entry === "action"
        ? deliverableFeishuActionCard(buildFeishuActionPresentationCard({ presentation, cfg }))
        : undefined;
    if (params.entry !== "action") {
      let payload: ReplyPayload = { text: "", presentation };
      const ctx = { cfg, to: "chat_1", text: "", accountId: undefined, payload };
      if (params.entry === "core-rendered") {
        const rendered = await feishuOutbound.renderPresentation?.({
          payload,
          presentation,
          sourcePresentation: presentation,
          ctx,
        });
        const { presentation: _presentation, ...consumed } = rendered ?? payload;
        payload = consumed;
      }
      await feishuOutbound.sendPayload?.({ ...ctx, text: payload.text ?? "", payload });
      card = sendCardCall()?.card;
    }
    const elements = (card?.body.elements ?? []) as { tag: string; content?: string }[];
    expect(elements.some((element) => element.tag === "button")).toBe(true);
    const contents = elements.flatMap((element) =>
      element.tag === "markdown" ? [element.content ?? ""] : [],
    );
    expect(contents.length).toBeGreaterThan(1);
    for (const content of contents) {
      const outsideFences = content.replace(/^```[^\n]*\n[\s\S]*?^```$/gmu, "");
      expect(
        params.tables === "off"
          ? !content.includes("•")
          : !/^\|/mu.test(outsideFences) || hasCardMarkdownTable(outsideFences),
        `element starting ${JSON.stringify(content.slice(0, 40))}`,
      ).toBe(true);
    }
    const joined = contents.join("\n");
    expect(names.filter((name) => !new RegExp(`${name}\\b`, "u").test(joined))).toEqual([]);
  });

  async function presentationCardFor(
    entry: "action" | "raw" | "core",
    presentation: MessagePresentation,
    cfg: ClawdbotConfig,
  ) {
    if (entry === "action") {
      return deliverableFeishuActionCard(buildFeishuActionPresentationCard({ presentation, cfg }));
    }
    let payload: ReplyPayload = { text: "", presentation };
    if (entry === "core") {
      payload = await renderPresentationForDelivery(
        {
          presentationCapabilities: feishuOutbound.presentationCapabilities,
          renderPresentation: (adapted, source) =>
            feishuOutbound.renderPresentation?.({
              payload: adapted,
              presentation: adapted.presentation,
              sourcePresentation: source,
              ctx: {
                cfg,
                to: "chat_1",
                text: adapted.text ?? "",
                accountId: undefined,
                payload: adapted,
              },
            }) ?? null,
        },
        payload,
      );
    }
    const ctx = { cfg, to: "chat_1", text: payload.text ?? "", accountId: undefined, payload };
    await feishuOutbound.sendPayload?.(ctx);
    return sendCardCall()?.card;
  }

  const offTablesConfig: ClawdbotConfig = { channels: { feishu: { markdown: { tables: "off" } } } };
  const okButtons: MessagePresentation["blocks"][number] = {
    type: "buttons",
    buttons: [{ label: "Ok", action: { type: "command", command: "/ok" } }],
  };
  const presentationEntries = ["action", "raw", "core"] as const;

  function markdownContents(card: { body: { elements: unknown[] } } | undefined) {
    const elements = (card?.body.elements ?? []) as { tag: string; content?: string }[];
    return elements.flatMap((element) =>
      element.tag === "markdown" ? [element.content ?? ""] : [],
    );
  }

  it.each(
    presentationEntries.flatMap((entry) =>
      (["default", "off"] as const).map((tables) => ({ entry, tables })),
    ),
  )(
    "keeps a short $entry presentation table whole beside long prose ($tables)",
    async ({ entry, tables }) => {
      const table = [
        `| Name | ${"H".repeat(500)} |`,
        "| --- | --- |",
        ...Array.from({ length: 55 }, (_entry, index) => `| person-${index} | x |`),
      ].join("\n");
      const presentation: MessagePresentation = {
        blocks: [{ type: "text", text: `${table}\n\n${"p".repeat(4000)}` }, okButtons],
      };
      const card = await presentationCardFor(
        entry,
        presentation,
        tables === "off" ? offTablesConfig : emptyConfig,
      );

      expectDeliverableWithControls(card);
      const contents = markdownContents(card);
      if (tables === "off") {
        expect(contents.join("\n")).toContain("person-54");
        return;
      }
      const holders = contents.filter((content) => content.includes(table));
      expect(holders.length).toBe(1);
      expect(hasCardMarkdownTable(holders[0] ?? "")).toBe(true);
    },
  );

  it.each(
    presentationEntries.flatMap((entry) =>
      (["narrow", "three"] as const).map((shape) => ({ entry, shape })),
    ),
  )(
    "keeps a $shape oversized table card deliverable and readable on the $entry entry",
    async ({ entry, shape }) => {
      const rows = (count: number, tag: string) => [
        `| Name | ${tag}xxxx |`,
        "| --- | --- |",
        ...Array.from({ length: count }, (_row, index) => `| ${tag}-person-${index} | cccccc |`),
      ];
      const text =
        shape === "narrow"
          ? `${rows(800, "N").join("\n")}\n\n${"p".repeat(4000)}`
          : ["A", "B", "C"].map((tag) => rows(240, tag).join("\n")).join("\n\nprose\n\n");
      expect(text.length).toBeGreaterThan(shape === "narrow" ? 20000 : 17000);
      const card = await presentationCardFor(
        entry,
        { blocks: [{ type: "text", text }, okButtons] },
        emptyConfig,
      );

      expectDeliverableWithControls(card);
      const contents = markdownContents(card);
      const lastTag = shape === "narrow" ? "N-person-799" : "C-person-239";
      for (const content of contents) {
        const [first = "", second = ""] = content.split("\n");
        expect(!first.startsWith("|") || /^\|[ :|-]*-[ :|-]*\|$/u.test(second)).toBe(true);
      }
      expect(contents.join("\n")).toContain(`| ${lastTag} | cccccc |`);
    },
  );

  const wideTables = (tags: string[], header: number) =>
    tags
      .map((tag) =>
        [
          `| Name | ${tag}${"H".repeat(header)} |`,
          "| --- | --- |",
          ...Array.from({ length: 200 }, (_row, index) => `| ${tag}person-${index} | x |`),
        ].join("\n"),
      )
      .join("\n\n");

  it.each(
    presentationEntries.flatMap((entry) => [
      { entry, tables: "default" as const, tags: [""], header: 3_500 },
      { entry, tables: "off" as const, tags: [""], header: 3_500 },
      { entry, tables: "default" as const, tags: ["A-", "B-", "C-", "D-", "E-"], header: 1_500 },
    ]),
  )(
    "keeps the controls of a wide-header card the raw cut delivered on the $entry entry ($tables, $tags)",
    async ({ entry, tables, tags, header }) => {
      const text = wideTables(tags, header);
      const card = await presentationCardFor(
        entry,
        { blocks: [{ type: "text", text }, okButtons] },
        tables === "off" ? offTablesConfig : emptyConfig,
      );
      expectDeliverableWithControls(card);
      if (tags.length === 1) {
        expect(text.length).toBe(7_215);
        expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(8_000);
      }
      expect(markdownContents(card).join("\n")).toContain(`| ${tags.at(-1)}person-199 | x |`);
    },
  );

  it.each(["default", "off"] as const)(
    "keeps every row of a long presentation table readable after core adapts it (%s)",
    async (tables) => {
      const names = Array.from({ length: 200 }, (_entry, index) => `person-number-${index}`);
      const rows = names.map((name) => `| ${name} | Regional Operations Lead |`);
      const text = ["Roster.", "", "| Name | Role |", "| --- | --- |", ...rows, "", "End."].join(
        "\n",
      );
      const card = await presentationCardFor(
        "core",
        { blocks: [{ type: "text", text }, okButtons] },
        tables === "off" ? offTablesConfig : emptyConfig,
      );

      const contents = markdownContents(card);
      expect(contents.length).toBeGreaterThan(1);
      for (const content of contents) {
        const [first = "", second = ""] = content.split("\n");
        expect(
          tables === "off"
            ? !content.includes("•")
            : !first.startsWith("|") || /^\|[ :|-]*-[ :|-]*\|$/u.test(second),
          `element starting ${JSON.stringify(content.slice(0, 40))}`,
        ).toBe(true);
      }
      const joined = contents.join("\n");
      expect(names.filter((name) => !new RegExp(`${name}\\b`, "u").test(joined))).toEqual([]);
    },
  );

  const tableModeConfig: ClawdbotConfig = {
    channels: {
      feishu: {
        appId: "cli_a1",
        appSecret: "local-test-placeholder", // pragma: allowlist secret
        renderMode: "raw",
        markdown: { tables: "bullets" },
        accounts: { work: { markdown: { tables: "off" } } },
      },
    },
  };

  it("resolves the markdown table mode for the named account on the post path", async () => {
    await sendText({
      cfg: tableModeConfig,
      to: "chat_1",
      text: tableMarkdown,
      accountId: "work",
    });
    await sendText({ cfg: tableModeConfig, to: "chat_1", text: tableMarkdown });
    expect(sendMessageCall(0)?.text).toBe(tableMarkdown);
    expect(sendMessageCall(1)?.text).toBe("**Ada**  \n• Role: Lead");
  });

  it.each([
    { selection: "defaultAccount", work: {} },
    {
      selection: "only configured account",
      work: { appId: "cli_a1", appSecret: "local-test-placeholder" }, // pragma: allowlist secret
    },
  ])("follows the $selection when the account id is omitted", async ({ selection, work }) => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          ...(selection === "defaultAccount" ? { defaultAccount: "work" } : {}),
          markdown: { tables: "off" },
          accounts: { work: { ...work, markdown: { tables: "bullets" } } },
        },
      },
    };
    await sendText({ cfg, to: "chat_1", text: tableMarkdown });
    expect(sendMessageCall()?.text).toBe(bulletsPost);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "piped", text: tableMarkdown, card: false },
    { shape: "pipeless", text: pipelessTableMarkdown, card: false },
    { shape: "fenced sample", text: fencedTableSample, card: true },
  ])("off sends a $shape table under renderMode card (card: $card)", async ({ text, card }) => {
    const cfg: ClawdbotConfig = {
      channels: { feishu: { renderMode: "card", markdown: { tables: "off" } } },
    };
    await sendText({ cfg, to: "chat_1", text, accountId: "main" });
    const [used, unused] = card
      ? [sendStructuredCardFeishuMock, sendMessageFeishuMock]
      : [sendMessageFeishuMock, sendStructuredCardFeishuMock];
    expect(mockCallArg(used)?.text).toBe(text);
    expect(unused).not.toHaveBeenCalled();
  });

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
      expect(table.length).toBeGreaterThan(200);
      await sendText({ cfg, to: "chat_1", text: table, accountId: "main" });
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text)).join("");
      expect(posted).toContain("```");
      expect(posted).toContain("Name");
      expect(posted).toContain("r39");
    },
  );

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
    expect(convertMarkdownTables(quoted, "code")).toContain("> ```");
    await sendText({ cfg, to: "chat_1", text: quoted, accountId: "main" });
    const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text));
    expect(posted.length).toBeGreaterThan(1);
    for (const message of posted) {
      expect((message.match(/^>?\s*```/gmu) ?? []).length % 2).toBe(0);
    }
    const joined = posted.join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("r11");
  });

  describe.each(["channel", "account"] as const)("configured at %s scope", (scope) => {
    const accountId = scope === "account" ? "work" : undefined;

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
      { tables: "code" as const, shape: "piped", card: true, text: tableMarkdown, sent: codeCard },
      ...(["block", undefined] as const).flatMap((tables) =>
        [{ shape: "piped", text: tableMarkdown }, ...nativeTableShapes].map(({ shape, text }) => ({
          tables,
          shape,
          card: true,
          text,
          sent: text,
        })),
      ),
    ])("$tables sends a $shape table (card: $card)", async (row) => {
      await sendText({ cfg: tableCfg(scope, row.tables), to: "chat_1", text: row.text, accountId });
      const [used, unused] = row.card
        ? [sendStructuredCardFeishuMock, sendMessageFeishuMock]
        : [sendMessageFeishuMock, sendStructuredCardFeishuMock];
      expect(mockCallArg(used)?.text).toBe(row.sent);
      expect(unused).not.toHaveBeenCalled();
    });

    it.each(
      undrawableTableShapes.flatMap(({ shape, text, posted }) =>
        (["block", undefined] as const).flatMap((tables) =>
          ["", `${fencedCodeSample}\n\n`].map((prefix) => ({
            shape,
            tables,
            after: prefix ? "a code fence" : "nothing",
            prefix,
            text,
            posted,
          })),
        ),
      ),
    )("$tables posts a $shape table as a fenced block after $after", async (row) => {
      await sendText({
        cfg: tableCfg(scope, row.tables),
        to: "chat_1",
        text: row.prefix + row.text,
        accountId,
      });
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageCall()?.text).toBe(row.prefix + row.posted);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });

    it.each(
      nonTableShapes.flatMap(({ shape, text }) =>
        (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
      ),
    )("$tables posts literal rows with $shape", async ({ tables, text }) => {
      await sendText({ cfg: tableCfg(scope, tables), to: "chat_1", text, accountId });
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageCall()?.text).toBe(text.replace(/(?<!\n)\n(?!\n)/g, "  \n"));
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });
  });

  it("converts a whole table through the formatted text sender", async () => {
    const rows = Array.from(
      { length: 400 },
      (_entry, index) => `| row${index} | detail ${index} |`,
    );
    const table = ["| name | detail |", "| --- | --- |", ...rows].join("\n");
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
    for (const message of delivered) {
      if (!message.includes("|")) {
        continue;
      }
      expect(message).toContain("```");
    }
    expect(delivered.join("")).toContain("row399");
  });
});
