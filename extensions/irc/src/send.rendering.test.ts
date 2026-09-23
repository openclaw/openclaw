import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";
import { sendFormattedIrcText } from "./message-adapter.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

describe("IRC formatted text on the wire", () => {
  let server: Awaited<ReturnType<typeof startIrcTestServer>>;
  let cfg: CoreConfig;
  let lines: string[];
  let disconnected: Promise<void>;

  beforeEach(async () => {
    lines = [];
    disconnected = Promise.resolve();
    server = await startIrcTestServer((socket) => {
      disconnected = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      onIrcTestLine(socket, (line) => {
        lines.push(line);
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
        }
        if (line.startsWith("QUIT")) {
          socket.end();
        }
      });
    });
    cfg = {
      channels: { irc: { host: "127.0.0.1", port: server.port, tls: false, nick: "bot" } },
    };
  });

  afterEach(async () => {
    await server.close();
  });

  it.each([undefined, "parent-1"])(
    "rejects sanitized-empty content without reporting delivery (reply %s)",
    async (replyToId) => {
      const core = createPluginRuntimeMock();
      setIrcRuntime(core);
      const onDeliveryResult = vi.fn();

      await expect(
        sendFormattedIrcText({
          cfg,
          to: "#room",
          text: String.raw`\n`,
          replyToId,
          onDeliveryResult,
        }),
      ).rejects.toThrow("Message must be non-empty for IRC sends");
      await disconnected;

      expect(lines.some((line) => line.startsWith("PRIVMSG "))).toBe(false);
      expect(onDeliveryResult).not.toHaveBeenCalled();
      expect(core.channel.activity.record).not.toHaveBeenCalled();
      expect(server.openSocketCount()).toBe(0);
    },
  );

  it("decodes message content once when adding a reply reference", async () => {
    const results = await sendFormattedIrcText({
      cfg,
      to: "#room",
      text: String.raw`\x5cn`,
      replyToId: "parent-1",
    });
    await disconnected;

    expect(lines.filter((line) => line.startsWith("PRIVMSG "))).toEqual([
      String.raw`PRIVMSG #room :\n  [reply:parent-1]`,
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.receipt?.replyToId).toBe("parent-1");
  });

  it.each([
    {
      name: "fenced literals across the chunk boundary",
      text: `\`\`\`text\n${"x".repeat(340)}\n**KEEP_LITERAL**\n\`\`\``,
      expected: `${"x".repeat(340)} **KEEP_LITERAL**`,
    },
    {
      name: "a closing fence beyond the chunk boundary",
      text: `\`\`\`text\n${"x".repeat(345)}\n\`\`\``,
      expected: "x".repeat(345),
    },
    {
      name: "inline literals across the chunk boundary",
      text: `\`${"x".repeat(340)} **KEEP_LITERAL**\``,
      expected: `${"x".repeat(340)} **KEEP_LITERAL**`,
    },
    {
      name: "a long link label and its destination",
      text: `[${"word ".repeat(80).trim()}](https://example.com/docs)`,
      expected: `${"word ".repeat(80).trim()} (https://example.com/docs)`,
    },
  ])("preserves $name", async ({ text, expected }) => {
    const results = await sendFormattedIrcText({ cfg, to: "#room", text });
    await disconnected;

    const bodies = lines
      .filter((line) => line.startsWith("PRIVMSG #room :"))
      .map((line) => line.slice("PRIVMSG #room :".length));
    expect(bodies.join(" ")).toBe(expected);
    expect(results).toHaveLength(bodies.length);
    expect(lines.filter((line) => line.startsWith("USER "))).toHaveLength(1);
    expect(server.openSocketCount()).toBe(0);
  });

  it.each([
    { source: "implicit", mode: "first", textLimit: undefined, replies: "first" },
    { source: "implicit", mode: "all", textLimit: undefined, replies: "all" },
    { source: "explicit", mode: "first", textLimit: 16, replies: "all" },
  ] as const)("keeps $source/$mode replies with limit $textLimit", async (testCase) => {
    cfg.channels!.irc!.textChunkLimit = 40;
    cfg.channels!.irc!.accounts = { work: { textChunkLimit: 10 } };
    const results = await sendFormattedIrcText({
      cfg,
      accountId: "work",
      to: "#room",
      text: "**alpha beta gamma delta**",
      formatting: testCase.textLimit ? { textLimit: testCase.textLimit } : undefined,
      replyToId: "parent-1",
      replyToIdSource: testCase.source,
      replyToMode: testCase.mode,
    });
    await disconnected;

    const messages = lines.filter((line) => line.startsWith("PRIVMSG #room :"));
    const replyCount = testCase.replies === "first" ? 1 : messages.length;
    expect(results).toHaveLength(messages.length);
    expect(results.filter((result) => result.receipt?.replyToId === "parent-1")).toHaveLength(
      replyCount,
    );
    expect(messages.filter((line) => line.endsWith("[reply:parent-1]"))).toHaveLength(replyCount);
    const bodies = messages.map((line) =>
      line.slice("PRIVMSG #room :".length).replace(/ {2}\[reply:parent-1\]$/, ""),
    );
    expect(bodies.join(" ")).toBe("alpha beta gamma delta");
    expect(bodies.every((body) => body.length <= (testCase.textLimit ?? 10))).toBe(true);
    if (testCase.textLimit) {
      expect(bodies.some((body) => body.length > 10)).toBe(true);
    }
  });
});
