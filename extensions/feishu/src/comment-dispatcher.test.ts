// Feishu tests cover delivery through the comment event handler.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const createCommentTypingReactionLifecycleMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "private.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

vi.mock("./monitor.comment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.comment.js")>()),
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-reaction.js", () => ({
  createCommentTypingReactionLifecycle: createCommentTypingReactionLifecycleMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

const commandButton = (label: string, command: string) => ({
  label,
  action: { type: "command" as const, command },
});
const buttons = (...items: Array<ReturnType<typeof commandButton>>) => ({
  blocks: [{ type: "buttons" as const, buttons: items }],
});
const approve = buttons(commandButton("Approve", "/approve req_1"));
const unavailable =
  "> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.";

describe("Feishu comment event reply delivery", () => {
  afterAll(() => {
    vi.doUnmock("./monitor.comment.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./comment-reaction.js");
    vi.doUnmock("./drive.js");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  const cfg: ClawdbotConfig = {
    channels: { feishu: { dmPolicy: "open", allowFrom: ["*"] } },
  };
  let runtime: ReturnType<typeof createPluginRuntimeMock>;

  async function createTestCommentTurn(turnCfg: ClawdbotConfig = cfg) {
    await handleFeishuCommentEvent({
      cfg: turnCfg,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      accountId: "main",
      event: { event_id: "evt_1" },
    });
    const turn = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0];
    if (!turn) {
      throw new Error("Expected Feishu comment turn");
    }
    return turn;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({});
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      messageId: "drive-comment:evt_1",
      senderId: "ou_sender",
      fileToken: "doc_token_1",
      fileType: "docx",
      commentId: "comment_1",
      replyId: "reply_1",
      isWholeComment: false,
      prompt: "Review this document",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    });
    runtime = createPluginRuntimeMock({
      config: { current: () => cfg },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            channel: "feishu",
            accountId: "main",
            sessionKey: "agent:main:feishu:direct:ou_sender",
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "binding.channel",
          }),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn((): "newline" => "newline"),
          resolveMarkdownTableMode: vi.fn((): "code" => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
      },
    });
    setFeishuRuntime(runtime);
  });

  it("sends final comment text without waiting for typing cleanup", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanupPromise = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const cleanup = vi.fn(() => cleanupPromise);
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup,
    });

    const created = await createTestCommentTurn();
    const deliverPromise = Promise.resolve(
      created.delivery.deliver({ text: "hello world" }, { kind: "final" }),
    );
    const status = await raceWithNextMacrotask(deliverPromise.then(() => "done"));

    expect(status).toBe("done");
    const client = createFeishuClientMock.mock.results[0]?.value;
    if (!client) {
      throw new Error("Expected Feishu client");
    }
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(client, {
      file_token: "doc_token_1",
      file_type: "docx",
      comment_id: "comment_1",
      content: "hello world",
      is_whole_comment: false,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);

    created.dispatcherOptions?.onCleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(2);

    resolveCleanup?.();
    await deliverPromise;
  });

  it("does not send whitespace-only comment replies without attachments", async () => {
    const created = await createTestCommentTurn();

    const result = await created.delivery.deliver({ text: "  \n\t " }, { kind: "final" });

    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ visibleReplySent: false });
  });

  it.each([
    [
      "caption, actionable presentation, and safe attachment",
      {
        text: "Review this",
        mediaUrl: "https://example.com/attachment.png",
        presentation: approve,
      },
      `Review this\n\n- Approve: \`/approve req_1\`\n\n${unavailable}\n\nhttps://example.com/attachment.png`,
    ],
    [
      "legacy interactive command",
      { interactive: approve },
      `- Approve: \`/approve req_1\`\n\n${unavailable}`,
    ],
    [
      "select option with an actionable command",
      {
        presentation: {
          blocks: [
            {
              type: "select" as const,
              placeholder: "Choose deployment",
              options: [commandButton("Deploy", "/deploy staging")],
            },
          ],
        },
      },
      `Choose deployment:\n- Deploy: \`/deploy staging\`\n\n${unavailable}`,
    ],
    [
      "URL-only button without actionable guidance",
      {
        presentation: {
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                {
                  label: "Open",
                  action: { type: "url" as const, url: "https://example.com/action" },
                },
              ],
            },
          ],
        },
      },
      "- Open: https://example.com/action",
    ],
  ])("delivers %s as safe plain-text comment links", async (_label, payload, expected) => {
    const created = await createTestCommentTurn();

    const result = await created.delivery.deliver(payload, { kind: "final" });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: expected }),
    );
    expect(result).toMatchObject({ content: expected, visibleReplySent: true });
  });

  it.each([
    ["local path", "/private/tmp/voice.mp3"],
    ["loopback URL", "http://127.0.0.1:3000/voice.mp3"],
    ["private DNS", "https://private.example.test/voice.mp3"],
    ["credentialed URL", "https://operator:secret@example.com/voice.mp3"],
  ])("does not disclose a %s in comment reply media fallbacks", async (_label, mediaUrl) => {
    const created = await createTestCommentTurn();

    const result = await created.delivery.deliver({ mediaUrl }, { kind: "final" });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: "Media upload failed. Please try again." }),
    );
    expect(result).toMatchObject({
      content: "Media upload failed. Please try again.",
      visibleReplySent: true,
    });
    expect(deliverCommentThreadTextMock.mock.calls[0]?.[1]?.content).not.toContain(mediaUrl);
  });

  it("chunks the transformed comment text including attachment links", async () => {
    const chunkMarkdownTextWithMode = vi
      .mocked(runtime.channel.text.chunkMarkdownTextWithMode)
      .mockImplementation((text: string) =>
        Array.from({ length: Math.ceil(text.length / 12) }, (_value, index) =>
          text.slice(index * 12, (index + 1) * 12),
        ),
      );
    vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(12);
    const expected = "caption\n\nhttps://example.com/file.png";
    const created = await createTestCommentTurn();

    const result = await created.delivery.deliver(
      { text: "caption", mediaUrl: "https://example.com/file.png" },
      { kind: "final" },
    );

    expect(chunkMarkdownTextWithMode).toHaveBeenCalledWith(expected, 12, "newline");
    expect(
      deliverCommentThreadTextMock.mock.calls.every((call) => call[1].content.length <= 12),
    ).toBe(true);
    expect(result).toMatchObject({ content: expected, visibleReplySent: true });
  });

  describe("markdown table modes", () => {
    const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
    let actual: typeof import("openclaw/plugin-sdk/markdown-table-runtime");

    beforeEach(async () => {
      actual = await vi.importActual<typeof import("openclaw/plugin-sdk/markdown-table-runtime")>(
        "openclaw/plugin-sdk/markdown-table-runtime",
      );
      vi.mocked(runtime.channel.text.resolveMarkdownTableMode).mockImplementation(
        actual.resolveMarkdownTableMode,
      );
      vi.mocked(runtime.channel.text.convertMarkdownTables).mockImplementation(
        actual.convertMarkdownTables,
      );
      // Feishu declares block as its plugin default; the harness registers the
      // same meta because it does not load the runtime setup.
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "feishu",
            source: "test",
            plugin: {
              id: "feishu",
              meta: { id: "feishu" },
              messaging: { defaultMarkdownTableMode: "block" },
            },
          },
        ]),
      );
    });

    afterEach(() => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
    });

    it.each(["bullets", "code", undefined, "off"] as const)(
      "converts a table before comment delivery in %s mode",
      async (tables: MarkdownTableMode | undefined) => {
        const expected =
          tables === "off"
            ? tableMarkdown
            : actual.convertMarkdownTables(
                tableMarkdown,
                tables === "bullets" ? "bullets" : "code",
              );
        const tableCfg: ClawdbotConfig = {
          channels: {
            feishu: {
              dmPolicy: "open",
              allowFrom: ["*"],
              ...(tables ? { markdown: { tables } } : {}),
            },
          },
        };
        vi.spyOn(runtime.config, "current").mockReturnValue(tableCfg);
        const created = await createTestCommentTurn(tableCfg);

        await created.delivery.deliver({ text: tableMarkdown }, { kind: "final" });

        expect(deliverCommentThreadTextMock.mock.calls[0]?.[1]?.content).toBe(expected);
      },
    );

    // A converted table is one fenced block, so the chunker that splits it has to
    // close and reopen the fence instead of cutting the block in half. This covers an
    // ordinary table at a workable limit, in both real chunk modes.
    // A limit that cannot carry the marker pair around one character of content would
    // leave the first comment opening a code block nothing closes and the last closing
    // one nothing opened. The table is left as it arrived instead. Nine characters is
    // that floor only for the shortest pair, so the guard reads the marker the
    // conversion produced.
    it("leaves a comment table unconverted when the limit cannot hold a fence", async () => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(8);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();

      await created.delivery.deliver({ text: tableMarkdown }, { kind: "final" });

      const contents = deliverCommentThreadTextMock.mock.calls.map(
        (call) => call[1].content as string,
      );
      const joined = contents.join("");
      // No comment carries a fence marker at all, so none can be unterminated.
      expect(joined).not.toContain("`");
      // Every cell still arrives. The chunker trims at the boundaries it cuts on, so
      // the joined text is not the authored string, but nothing is dropped.
      for (const cell of ["Name", "Role", "Ada", "Lead"]) {
        expect(joined).toContain(cell);
      }
      for (const content of contents) {
        expect(content.length).toBeLessThanOrEqual(8);
      }
    });

    const fenceShapeTable = (prefix: string, nameCell = "Ada") =>
      [
        "Roster",
        "",
        ...["| Name | Role |", "| --- | --- |", `| ${nameCell} | \`\`\` |`].map(
          (line) => `${prefix}${line}`,
        ),
      ].join("\n");

    // Shapes the chunker cannot cut without stranding a fence. A cell holding a backtick
    // run the parser cannot pair keeps those characters as text and lengthens the marker.
    // An indent widens the line the chunker has to fit at both ends. A quote prefix hides
    // the marker from the fence scanner, which no limit repairs, so only a text short
    // enough never to be cut is safe there. Below a handful of characters the cut lands
    // inside the marker and delivers backtick fragments. A surrogate pair can push a
    // balanced chunk one unit past the limit, which is core's split rule rather than this
    // conversion, so the conversion declines to add a fence on top of it. The leading line
    // matters: the send trims the text, and a trim on the table's own first line would
    // take the indent with it.
    it.each([
      { shape: "a cell lengthens the marker", authored: fenceShapeTable(""), limit: 10 },
      { shape: "an indent widens the marker line", authored: fenceShapeTable(" "), limit: 11 },
      { shape: "a quote prefix hides the marker", authored: fenceShapeTable("> "), limit: 40 },
      { shape: "the limit cannot carry the marker", authored: fenceShapeTable(""), limit: 2 },
      {
        shape: "a surrogate pair outgrows the limit",
        authored: fenceShapeTable("", "\u{1F600}"),
        limit: 11,
      },
    ])("leaves a comment table unconverted when $shape", async ({ authored, limit }) => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(limit);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();
      // Guard the fixture: the shape only means anything while the conversion still has a
      // marker to strand.
      expect(actual.convertMarkdownTables(authored, "code")).toContain("````");

      await created.delivery.deliver({ text: authored }, { kind: "final" });

      // The comments are the authored text cut up, not the converted table. Comparing
      // against the chunker itself avoids asking a copy of the guard whether the guard
      // was right.
      expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
        chunking.chunkMarkdownTextWithMode(authored, limit, "length"),
      );
    });

    // The conversion still runs wherever the pieces do survive, including one character
    // above and below the floor a lengthened marker sets. An authored code block with a
    // language tag opens a fence too, and a guard that cannot read it as an opener takes
    // its closing marker for one and stops an unrelated table converting at any limit.
    it.each([
      { shape: "a lengthened marker at its floor", limit: 11 },
      { shape: "a lengthened marker above its floor", limit: 13 },
    ])("converts a comment table with $shape", async ({ limit }) => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(limit);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();
      const authored = "| Name | Role |\n| --- | --- |\n| Ada | ``` |";
      const converted = actual.convertMarkdownTables(authored, "code");

      await created.delivery.deliver({ text: authored }, { kind: "final" });

      expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
        chunking.chunkMarkdownTextWithMode(converted, limit, "length"),
      );
    });

    // A CRLF source leaves the carriage return on the generated closing marker, because
    // the line split is on the feed alone, and a closer that insisted on nothing but
    // whitespace after the backticks read that as unbalanced and declined to convert.
    // Four spaces make a line indented code rather than a fence, which is where the
    // shared scanner draws the line. A guard that accepted any indentation read that
    // backtick line as an opener, paired it with the generated table's own opener, and
    // declined to convert a table that was never at risk.
    it("converts a comment table beside an indented code line", async () => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4000);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();
      const authored = `Example:\n\n    \`\`\`\n\n${tableMarkdown}`;
      const converted = actual.convertMarkdownTables(authored, "code");
      // Guard the fixture: the indented line survives conversion alongside the table.
      expect(converted).toContain("    ```");

      await created.delivery.deliver({ text: authored }, { kind: "final" });

      expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
        chunking.chunkMarkdownTextWithMode(converted, 4000, "length"),
      );
    });

    it("converts a comment table written with CRLF line endings", async () => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4000);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();
      const authored = `${tableMarkdown.split("\n").join("\r\n")}\r\n\r\nAfter the table.`;
      const converted = actual.convertMarkdownTables(authored, "code");
      // Guard the fixture: the closing marker carries the carriage return.
      expect(converted).toContain("```\r\n");

      await created.delivery.deliver({ text: authored }, { kind: "final" });

      expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
        chunking.chunkMarkdownTextWithMode(converted, 4000, "length"),
      );
    });

    it("converts a comment table that follows a language-tagged code block", async () => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4000);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();
      const authored = `\`\`\`js\nconst x = 1;\n\`\`\`\n\n${tableMarkdown}`;
      const converted = actual.convertMarkdownTables(authored, "code");
      // Guard the fixture: the authored block's own marker pair is what used to read as
      // an unclosed opener.
      expect(converted).toContain("```js");

      await created.delivery.deliver({ text: authored }, { kind: "final" });

      expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
        chunking.chunkMarkdownTextWithMode(converted, 4000, "length"),
      );
    });

    // A list marker on the opener's line carries on as indentation on the lines after it,
    // while a quote marker is repeated on each, so a table nested in both closes its fence
    // behind the quote alone. That closer belongs to the same block in either order, and a
    // guard that read it as a stranger declined a table that fits one comment whole.
    it.each([
      { shape: "a list inside a quote", first: "> - ", rest: ">   " },
      { shape: "a quote inside a list", first: "- > ", rest: "  > " },
    ])("converts a comment table nested in $shape", async ({ first, rest }) => {
      const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
        "openclaw/plugin-sdk/reply-chunking",
      );
      vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4000);
      vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
      vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
        chunking.chunkTextWithMode,
      );
      vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
        chunking.chunkMarkdownTextWithMode,
      );
      const created = await createTestCommentTurn();
      const rows = tableMarkdown.split("\n").map((row, index) => (index ? rest : first) + row);
      const authored = `Roster:\n\n${rows.join("\n")}`;
      const converted = actual.convertMarkdownTables(authored, "code");
      // Guard the fixture: the opener carries the list marker and the closer does not.
      expect(converted).toContain(`${first}\`\`\`\n`);
      expect(converted.endsWith(`\n${rest}\`\`\``)).toBe(true);

      await created.delivery.deliver({ text: authored }, { kind: "final" });

      expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
        chunking.chunkMarkdownTextWithMode(converted, 4000, "length"),
      );
    });

    // A quote that sits inside a list paragraph already in the message closes on its own line,
    // two columns into the list. A guard that forgot the list read that quote as too far in and
    // declined the table after it. A closer that leaves the list closes nothing, so that message
    // keeps its authored table.
    it.each([
      {
        shape: "closes inside the list",
        existing: "- item\n  > ```\n    > x\n  > ```",
        converts: true,
      },
      {
        shape: "leaves the list",
        existing: "- item\n  > - ```\n  >   x\n>   ```",
        converts: false,
      },
    ])(
      "handles a comment table after a quote whose closer $shape",
      async ({ existing, converts }) => {
        const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
          "openclaw/plugin-sdk/reply-chunking",
        );
        vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4000);
        vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
        vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
          chunking.chunkTextWithMode,
        );
        vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
          chunking.chunkMarkdownTextWithMode,
        );
        const created = await createTestCommentTurn();
        const authored = `${existing}\n\n${tableMarkdown}`;
        const converted = actual.convertMarkdownTables(authored, "code");
        // Guard the fixture: the table converts, so the guard is what decides.
        expect(converted).not.toBe(authored);

        await created.delivery.deliver({ text: authored }, { kind: "final" });

        expect(deliverCommentThreadTextMock.mock.calls.map((call) => call[1].content)).toEqual(
          chunking.chunkMarkdownTextWithMode(converts ? converted : authored, 4000, "length"),
        );
      },
    );

    it.each(["length", "newline"] as const)(
      "balances the fences of an oversized converted table in %s mode",
      async (chunkMode) => {
        const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
          "openclaw/plugin-sdk/reply-chunking",
        );
        const limit = 200;
        const wideTable = [
          "| Name | Role |",
          "| --- | --- |",
          ...Array.from(
            { length: 14 },
            (_value, index) => `| Member ${index} | Engineer ${index} |`,
          ),
        ].join("\n");
        vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(limit);
        vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue(chunkMode);
        vi.mocked(runtime.channel.text.chunkTextWithMode).mockImplementation(
          chunking.chunkTextWithMode,
        );
        vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockImplementation(
          chunking.chunkMarkdownTextWithMode,
        );
        const created = await createTestCommentTurn();

        await created.delivery.deliver({ text: wideTable }, { kind: "final" });

        const contents = deliverCommentThreadTextMock.mock.calls.map(
          (call) => call[1].content as string,
        );
        expect(actual.convertMarkdownTables(wideTable, "code").length).toBeGreaterThan(limit);
        // Keeping the block whole by widening the limit would hide the split, not repair it.
        expect(contents.length).toBeGreaterThan(1);
        for (const content of contents) {
          expect(content.length).toBeLessThanOrEqual(limit);
          expect((content.match(/^`{3,}/gm)?.length ?? 0) % 2).toBe(0);
        }
      },
    );
  });

  it("retains the accepted comment reply id and text when a later chunk fails", async () => {
    vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4);
    vi.mocked(runtime.channel.text.chunkMarkdownTextWithMode).mockReturnValue(["first", "second"]);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_native_1" })
      .mockRejectedValueOnce(new Error("second comment send failed"));
    const created = await createTestCommentTurn();

    const error = await Promise.resolve(
      created.delivery.deliver({ text: "firstsecond" }, { kind: "final" }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["reply_native_1"],
        content: "first",
        visibleReplySent: true,
      },
    });
  });
});
