// Exercise preferred Tlon sends through real HTTP against a loopback Urbit fixture.
import { once } from "node:events";
import * as http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tlonPlugin } from "./channel.js";

const TEXT_LIMIT = 10_000;
const textSender = tlonPlugin.message?.send?.text;
if (!textSender) {
  throw new Error("expected preferred Tlon text sender");
}
const targets = [
  { name: "DM", to: "~nec", threadId: undefined },
  { name: "group", to: "chat/~nec/general", threadId: undefined },
  { name: "thread", to: "chat/~nec/general", threadId: "1700000000000" },
];

function loopbackConfig(port: number) {
  return {
    channels: {
      tlon: {
        ship: "~zod",
        url: `http://127.0.0.1:${port}`,
        code: "mock-code",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
}

function finishLogin(response: http.ServerResponse) {
  response.writeHead(200, { "set-cookie": "urbauth-~zod=mock-cookie" });
  response.end("ok");
}

type TlonPoke = {
  app?: string;
  mark?: string;
  json?: {
    ship?: string;
    diff?: {
      delta?: {
        add?: {
          memo?: { content?: unknown; author?: string };
        };
      };
    };
  };
};

/** Join the plain-string run of a Tlon story the same way a reader reconstructs text. */
function extractStoryText(content: unknown): string {
  const verses = Array.isArray(content) ? (content as unknown[]) : [];
  const parts: string[] = [];
  for (const verse of verses) {
    if (
      verse &&
      typeof verse === "object" &&
      "inline" in verse &&
      Array.isArray((verse as { inline?: unknown }).inline)
    ) {
      for (const item of (verse as { inline: unknown[] }).inline) {
        if (typeof item === "string") {
          parts.push(item);
        }
      }
    }
  }
  return parts.join("");
}

type StoryVerseSummary = {
  prose: string[];
  code: Array<{ code: string; lang: string }>;
};

/** Split a story into its native prose runs and code-block payloads without flattening them. */
function extractStoryVerses(content: unknown): StoryVerseSummary {
  const verses = Array.isArray(content) ? (content as unknown[]) : [];
  const summary: StoryVerseSummary = { prose: [], code: [] };
  for (const verse of verses) {
    if (
      verse &&
      typeof verse === "object" &&
      "inline" in verse &&
      Array.isArray((verse as { inline?: unknown }).inline)
    ) {
      for (const item of (verse as { inline: unknown[] }).inline) {
        if (typeof item === "string") {
          summary.prose.push(item);
        }
      }
      continue;
    }
    const block =
      verse && typeof verse === "object" && "block" in verse
        ? (verse as { block?: unknown }).block
        : undefined;
    if (
      block &&
      typeof block === "object" &&
      "code" in block &&
      block.code &&
      typeof block.code === "object"
    ) {
      const codeBlock = block.code as { code?: unknown; lang?: unknown };
      if (typeof codeBlock.code === "string" && typeof codeBlock.lang === "string") {
        summary.code.push({ code: codeBlock.code, lang: codeBlock.lang });
      }
    }
  }
  return summary;
}

/** Total reader-visible characters carried by a story, for transport-limit checks. */
function storyPayloadLength(content: unknown): number {
  const verses = extractStoryVerses(content);
  return (
    verses.prose.join("").length + verses.code.reduce((sum, block) => sum + block.code.length, 0)
  );
}

describe("tlon outbound loopback", () => {
  let server: http.Server | undefined;

  async function listenLoopback(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
        server?.closeAllConnections?.();
      });
      server = undefined;
    }
  });

  type ChunkPokeRecorder = {
    pokes: TlonPoke[];
    rejectedOversized: Array<{ length: number }>;
    loginCount: number;
  };

  /** Loopback airlift fixture: accepts login, records channel pokes, rejects memos over the limit. */
  async function listenChunkPokeLoopback(recorder: ChunkPokeRecorder): Promise<number> {
    return listenLoopback((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/~/login") {
        recorder.loginCount += 1;
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "set-cookie": "urbauth-~zod=mock-cookie",
        });
        res.end("ok");
        return;
      }
      if (req.method === "PUT" && url.pathname.startsWith("/~/channel/")) {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          const received = JSON.parse(body) as TlonPoke[];
          recorder.pokes.push(...received);
          const oversized = received.some(
            (poke) => storyPayloadLength(poke.json?.diff?.delta?.add?.memo?.content) > TEXT_LIMIT,
          );
          if (oversized) {
            recorder.rejectedOversized.push({ length: received.length });
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("memo too long");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
  }

  it.each(["login", "redirect", "dispatch refresh"] as const)(
    "stops requests when authority closes during %s",
    async (phase) => {
      const paused = createDeferred<http.ServerResponse | undefined>();
      const resume = createDeferred<void>();
      const laterRequests: string[] = [];
      const port = await listenLoopback((req, res) => {
        if (req.url === "/~/login") {
          if (phase !== "dispatch refresh") {
            paused.resolve(res);
          } else {
            finishLogin(res);
          }
        } else {
          laterRequests.push(req.url ?? "");
          res.writeHead(204);
          res.end();
        }
      });
      const controller = new AbortController();
      const revoked = new Error(`authority closed during ${phase}`);
      const onPlatformSendDispatch = vi.fn(async () => {
        if (phase === "dispatch refresh") {
          paused.resolve(undefined);
          await resume.promise;
        }
      });
      const result = textSender({
        cfg: loopbackConfig(port),
        to: "~nec",
        text: "cancelled message",
        assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
        onPlatformSendDispatch,
      }).catch((error: unknown) => error);
      const response = await paused.promise;
      controller.abort(revoked);
      if (response) {
        if (phase === "redirect") {
          response.writeHead(302, { location: "/~/redirected-login" });
          response.end();
        } else {
          finishLogin(response);
        }
      }
      resume.resolve();

      expect(await result).toBe(revoked);
      expect(laterRequests).toEqual([]);
      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(phase === "dispatch refresh" ? 1 : 0);
    },
  );

  it.each(targets)(
    "retains an accepted $name result after authority closes",
    async ({ name, to, threadId }) => {
      const accepted = createDeferred<{ response: http.ServerResponse; payload: unknown }>();
      const port = await listenLoopback((req, res) => {
        if (req.url === "/~/login") {
          finishLogin(res);
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => accepted.resolve({ response: res, payload: JSON.parse(body) }));
      });
      const controller = new AbortController();
      const onPlatformSendDispatch = vi.fn(async () => {});
      const result = textSender({
        cfg: loopbackConfig(port),
        to,
        threadId,
        text: "accepted message",
        assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
        onPlatformSendDispatch,
      });
      const { response, payload } = await accepted.promise;
      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(1);
      const memo = { content: [{ inline: ["accepted message"] }], author: "~zod" };
      expect(payload).toMatchObject([
        name === "DM"
          ? {
              app: "chat",
              mark: "chat-dm-action",
              json: { ship: "~nec", diff: { delta: { add: { memo } } } },
            }
          : {
              app: "channels",
              mark: "channel-action-1",
              json: {
                channel: {
                  nest: "chat/~nec/general",
                  action: {
                    post: threadId
                      ? { reply: { id: "1.700.000.000.000", action: { add: memo } } }
                      : { add: memo },
                  },
                },
              },
            },
      ]);
      controller.abort(new Error("authority closed after poke acceptance"));
      response.writeHead(204);
      response.end();

      const sent = await result;
      expect(sent.receipt.parts).toHaveLength(1);
      expect(sent.receipt.parts[0]?.kind).toBe("text");
      expect(sent.receipt.platformMessageIds).toEqual([sent.messageId]);
    },
  );

  it("delivers each chunked unit as a bounded independent poke the urbit transport accepts", async () => {
    const recorder: ChunkPokeRecorder = { pokes: [], rejectedOversized: [], loginCount: 0 };
    const port = await listenChunkPokeLoopback(recorder);
    const { pokes, rejectedOversized } = recorder;

    const cfg = loopbackConfig(port);

    const outbound = tlonPlugin.outbound;
    if (!outbound) {
      throw new Error("expected tlon plugin to declare an outbound adapter");
    }
    const chunker = outbound.chunker;
    if (!chunker || outbound.textChunkLimit !== TEXT_LIMIT) {
      throw new Error("expected tlon outbound to declare a bounded chunker");
    }

    const text = "x".repeat(10_001);
    const chunks = chunker(text, TEXT_LIMIT);
    for (const chunk of chunks) {
      await outbound.sendText?.({ cfg, to: "~nec", text: chunk });
    }

    expect(outbound.chunkerMode).toBe("markdown");
    const fenced = "```py\n  a\n  b\n```\n\nend";
    expect(chunker(fenced, 14)).toEqual(["```py\n  a\n```", "```py\n  b\n```", "end"]);
    expect(chunks).toEqual(["x".repeat(TEXT_LIMIT), "x"]);
    expect(pokes).toHaveLength(chunks.length);
    expect(recorder.loginCount).toBeGreaterThan(0);
    // Every unit fits the transport limit, so the urbit transport accepts each poke.
    expect(rejectedOversized).toEqual([]);
    const delivered = pokes.map((poke) =>
      extractStoryText(poke.json?.diff?.delta?.add?.memo?.content),
    );
    expect(delivered.every((part) => part.length <= TEXT_LIMIT)).toBe(true);
    expect(delivered.join("")).toBe(text);
  });

  it("delivers a long fenced reply as native code-block verses the transport accepts", async () => {
    const recorder: ChunkPokeRecorder = { pokes: [], rejectedOversized: [], loginCount: 0 };
    const port = await listenChunkPokeLoopback(recorder);
    const { pokes, rejectedOversized } = recorder;

    const cfg = loopbackConfig(port);
    const outbound = tlonPlugin.outbound;
    if (!outbound) {
      throw new Error("expected tlon plugin to declare an outbound adapter");
    }
    const chunker = outbound.chunker;
    if (!chunker || outbound.textChunkLimit !== TEXT_LIMIT) {
      throw new Error("expected tlon outbound to declare a bounded chunker");
    }

    const codeLines = Array.from({ length: 1_200 }, (_, i) => `print(${i})`).join("\n");
    const text = `Here is the script:\n\n\`\`\`python\n${codeLines}\n\`\`\`\n\nDone.`;
    const chunks = chunker(text, TEXT_LIMIT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      await outbound.sendText?.({ cfg, to: "~nec", text: chunk });
    }

    // Every delivered poke stays inside the transport limit and no fence leaks into prose.
    expect(rejectedOversized).toEqual([]);
    expect(recorder.loginCount).toBeGreaterThan(0);
    const delivered = pokes.map((poke) =>
      extractStoryVerses(poke.json?.diff?.delta?.add?.memo?.content),
    );
    expect(delivered).toHaveLength(chunks.length);
    for (const [index, poke] of pokes.entries()) {
      const verses = delivered[index];
      if (!verses) {
        throw new Error("expected delivered verses for poke");
      }
      for (const prose of verses.prose) {
        expect(prose).not.toContain("```");
      }
      expect(storyPayloadLength(poke.json?.diff?.delta?.add?.memo?.content)).toBeLessThanOrEqual(
        TEXT_LIMIT,
      );
      for (const block of verses.code) {
        expect(block.lang).toBe("python");
      }
    }
    // Full code preservation across pokes, in order, with prose kept outside the code blocks.
    const deliveredCode = delivered.flatMap((verses) => verses.code.map((block) => block.code));
    expect(deliveredCode.join("\n")).toBe(codeLines);
    expect(delivered[0]?.prose.join("")).toContain("Here is the script:");
    expect(delivered.at(-1)?.prose.join("")).toContain("Done.");
  });

  it("redacts a reflected session cookie from a rejected poke", async () => {
    const cookie = "urbauth-~zod=0v1g.abcde.ijklm.prst";
    const port = await listenLoopback((req, res) => {
      if (req.url === "/~/login") {
        res.writeHead(200, { "set-cookie": cookie });
        res.end("ok");
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`invalid session: ${req.headers.cookie}`);
    });

    const error = await textSender({
      cfg: loopbackConfig(port),
      to: "~nec",
      text: "reflected credentials",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Poke failed: 500");
    expect(message).toContain("invalid session");
    expect(message).not.toContain(cookie);
  });
});
