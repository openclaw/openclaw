import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ircPlugin } from "./channel.js";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const sendFormattedIrcText = ircPlugin.outbound!.sendFormattedText!;
type SendOptions = Partial<Parameters<typeof sendFormattedIrcText>[0]>;
const padding = "x".repeat(340);
const literal = `${padding} **KEEP_LITERAL**`;
const label = "word ".repeat(80).trim();
const url = "https://example.com/docs";
const prefix = "PRIVMSG #room :";

describe("IRC formatted text on the wire", () => {
  let server: Awaited<ReturnType<typeof startIrcTestServer>>;
  let cfg: CoreConfig;
  let lines: string[];
  let disconnected: Promise<void>;
  const messages = () => lines.filter((line) => line.startsWith(prefix));
  const send = async (text: string, options: SendOptions = {}) => {
    const results = await sendFormattedIrcText({ cfg, to: "#room", text, ...options });
    await disconnected;
    expect(results).toHaveLength(messages().length);
    expect(server.openSocketCount()).toBe(0);
    return results;
  };

  beforeEach(async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "irc", plugin: ircPlugin, source: "test" }]),
    );
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
    cfg = { channels: { irc: { host: "127.0.0.1", port: server.port, tls: false, nick: "bot" } } };
  });

  afterEach(() => server.close());

  it.each([undefined, "parent-1"])("rejects sanitized-empty (%s)", async (replyToId) => {
    const core = createPluginRuntimeMock();
    setIrcRuntime(core);
    const onDeliveryResult = vi.fn();

    await expect(send("\u0001", { replyToId, onDeliveryResult })).rejects.toThrow(
      "Message must be non-empty for IRC sends",
    );
    await disconnected;

    expect(lines.some((line) => line.startsWith("PRIVMSG "))).toBe(false);
    expect(onDeliveryResult).not.toHaveBeenCalled();
    expect(core.channel.activity.record).not.toHaveBeenCalled();
    expect(server.openSocketCount()).toBe(0);
  });

  it("sends literal backslash sequences unchanged with a reply reference", async () => {
    const results = await send(String.raw`Run C:\tools\new.exe or printf("%d\n") with \x41`, {
      replyToId: "parent-1",
    });
    expect(lines.filter((line) => line.startsWith("PRIVMSG "))).toEqual([
      String.raw`PRIVMSG #room :Run C:\tools\new.exe or printf("%d\n") with \x41  [reply:parent-1]`,
    ]);
    expect(results[0]?.receipt?.replyToId).toBe("parent-1");
  });

  it.each([
    ["code", "PRIVMSG #room :| Name | State | | ---- | ----- | | docs | ready |"],
    ["bullets", "PRIVMSG #room :docs \u2022 State: ready"],
  ] as const)("renders %s tables as plain text on the wire", async (mode, expected) => {
    cfg.channels!.irc!.markdown = { tables: mode };
    await send("  | Name | State |\n| --- | --- |\n| **docs** | ready |  ");
    expect(lines.filter((line) => line.startsWith("PRIVMSG "))).toEqual([expected]);
  });

  it.each([
    ["fenced literals across chunks", `\`\`\`text\n${padding}\n**KEEP_LITERAL**\n\`\`\``, literal],
    ["a closing fence beyond chunks", `\`\`\`text\n${"x".repeat(345)}\n\`\`\``, "x".repeat(345)],
    ["inline literals across chunks", `\`${literal}\``, literal],
    ["a long link label and its destination", `[${label}](${url})`, `${label} (${url})`],
  ])("preserves %s", async (_name, text, expected) => {
    await send(text);
    const bodies = messages().map((line) => line.slice(prefix.length));
    expect(bodies.join(" ")).toBe(expected);
    expect(lines.filter((line) => line.startsWith("USER "))).toHaveLength(1);
  });

  it.each([
    { source: "implicit", mode: "first", textLimit: undefined, replies: "first" },
    { source: "implicit", mode: "all", textLimit: undefined, replies: "all" },
    { source: "explicit", mode: "first", textLimit: 16, replies: "all" },
  ] as const)("$source/$mode replies, limit $textLimit", async (row) => {
    const { source, mode, textLimit, replies } = row;
    cfg.channels!.irc!.textChunkLimit = 40;
    cfg.channels!.irc!.accounts = { work: { textChunkLimit: 10 } };
    const results = await send("**alpha beta gamma delta**", {
      accountId: "work",
      formatting: textLimit ? { textLimit } : undefined,
      replyToId: "parent-1",
      replyToIdSource: source,
      replyToMode: mode,
    });
    const sent = messages();
    const replyCount = replies === "first" ? 1 : sent.length;
    const repliesSent = results.filter(({ receipt }) => receipt?.replyToId === "parent-1");
    expect(repliesSent).toHaveLength(replyCount);
    expect(sent.filter((line) => line.endsWith("[reply:parent-1]"))).toHaveLength(replyCount);
    const bodies = sent.map((line) =>
      line.slice(prefix.length).replace(/ {2}\[reply:parent-1\]$/, ""),
    );
    expect(bodies.join(" ")).toBe("alpha beta gamma delta");
    expect(bodies.every((body) => body.length <= (textLimit ?? 10))).toBe(true);
    if (textLimit) {
      expect(bodies.some((body) => body.length > 10)).toBe(true);
    }
  });
});
