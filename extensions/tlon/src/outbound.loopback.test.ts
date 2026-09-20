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

  it.each(targets)(
    "stops a $name send revoked while authentication is pending",
    async ({ to, threadId }) => {
      const login = createDeferred<http.ServerResponse>();
      const pokes: string[] = [];
      const port = await listenLoopback((req, res) => {
        if (req.url === "/~/login") {
          login.resolve(res);
          return;
        }
        pokes.push(req.url ?? "");
        res.writeHead(204);
        res.end();
      });
      const controller = new AbortController();
      const revoked = new Error("Tlon delivery authority revoked");
      const onPlatformSendDispatch = vi.fn(async () => {});
      const result = textSender({
        cfg: loopbackConfig(port),
        to,
        threadId,
        text: "cancelled message",
        assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
        onPlatformSendDispatch,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const response = await login.promise;
      controller.abort(revoked);
      finishLogin(response);

      expect(await result).toEqual({ error: revoked });
      expect(pokes).toEqual([]);
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    },
  );

  it("checks authority again before following an authentication redirect", async () => {
    const login = createDeferred<http.ServerResponse>();
    const laterRequests: string[] = [];
    const port = await listenLoopback((req, res) => {
      if (req.url === "/~/login") {
        login.resolve(res);
      } else {
        laterRequests.push(req.url ?? "");
        finishLogin(res);
      }
    });
    const controller = new AbortController();
    const revoked = new Error("authority closed during login");
    const onPlatformSendDispatch = vi.fn(async () => {});
    const result = textSender({
      cfg: loopbackConfig(port),
      to: "~nec",
      text: "cancelled message",
      assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
      onPlatformSendDispatch,
    }).catch((error: unknown) => error);
    const response = await login.promise;
    controller.abort(revoked);
    response.writeHead(302, { location: "/~/redirected-login" });
    response.end();

    expect(await result).toBe(revoked);
    expect(laterRequests).toEqual([]);
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
  });

  it("checks authority after awaiting the recipient-visible dispatch refresh", async () => {
    const dispatch = createDeferred<void>();
    const resume = createDeferred<void>();
    const pokes: string[] = [];
    const port = await listenLoopback((req, res) => {
      if (req.url === "/~/login") {
        finishLogin(res);
      } else {
        pokes.push(req.url ?? "");
        res.writeHead(204);
        res.end();
      }
    });
    const controller = new AbortController();
    const revoked = new Error("authority closed during dispatch refresh");
    const result = textSender({
      cfg: loopbackConfig(port),
      to: "~nec",
      text: "cancelled message",
      assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
      onPlatformSendDispatch: async () => {
        dispatch.resolve();
        await resume.promise;
      },
    }).catch((error: unknown) => error);
    await dispatch.promise;
    controller.abort(revoked);
    resume.resolve();

    expect(await result).toBe(revoked);
    expect(pokes).toEqual([]);
  });

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
    const pokes: TlonPoke[] = [];
    const rejectedOversized: Array<{ length: number }> = [];
    let loginCount = 0;
    const port = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/~/login") {
        loginCount += 1;
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
          pokes.push(...received);
          const oversized = received.some(
            (poke) =>
              extractStoryText(poke.json?.diff?.delta?.add?.memo?.content).length > TEXT_LIMIT,
          );
          if (oversized) {
            rejectedOversized.push({ length: received.length });
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

    const cfg = {
      channels: {
        tlon: {
          enabled: true,
          ship: "~zod",
          url: `http://127.0.0.1:${port}`,
          code: "mock-code",
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    };

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

    expect(chunks.length).toBeGreaterThan(1);
    expect(pokes).toHaveLength(chunks.length);
    expect(loginCount).toBeGreaterThan(0);
    // Every unit fits the transport limit, so the urbit transport accepts each poke.
    expect(rejectedOversized).toEqual([]);
    const delivered = pokes.map((poke) =>
      extractStoryText(poke.json?.diff?.delta?.add?.memo?.content),
    );
    expect(delivered.every((part) => part.length <= TEXT_LIMIT)).toBe(true);
    expect(delivered.join("")).toBe(text);
  });
});
