import { once } from "node:events";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import { tlonRuntimeOutbound } from "../channel.runtime.js";
import { ensureUrbitChannelOpen, pokeUrbitChannel, scryUrbitPath } from "./channel-ops.js";
import { UrbitHttpError } from "./errors.js";
import { UrbitSSEClient } from "./sse-client.js";

const COOKIE = "urbauth-~zod=0v1g.abcde.ijklm.prst";
const PATH = "/groups-ui/v6/init.json";
let server: ReturnType<typeof createServer>;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});
async function serve(handler: RequestListener) {
  const closed: Promise<unknown>[] = [];
  server = createServer((request, response) => {
    if (request.method !== "POST") {
      closed.push(once(request.socket, "close"));
    }
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cookie: COOKIE,
    ship: "~zod",
    channelId: "test",
    ssrfPolicy: { allowPrivateNetwork: true },
    closed: () => Promise.all(closed).then(() => undefined),
  };
}
const scry = async (handler: RequestListener) =>
  scryUrbitPath(await serve(handler), { path: PATH, auditContext: "test" });
const poke = async (handler: RequestListener) =>
  pokeUrbitChannel(await serve(handler), {
    app: "test",
    mark: "test",
    json: {},
    auditContext: "test",
  });
function streamBody(res: ServerResponse, size: number, suffix = "") {
  const chunk = Buffer.alloc(64 * 1024, "X");
  let written = 0;
  const write = () => {
    if (res.destroyed) {
      return;
    }
    if (written >= size) {
      res.end(suffix);
      return;
    }
    written += chunk.length;
    if (res.write(chunk)) {
      setImmediate(write);
    } else {
      res.once("drain", write);
    }
  };
  write();
}

it.each(["success", "creation", "activation"])("releases channel %s bodies", async (step) => {
  let puts = 0;
  const deps = await serve((request, response) => {
    if (request.method !== "PUT") {
      response.writeHead(404).end();
      return;
    }
    const fail = step === "creation" || (step === "activation" && puts === 1);
    puts++;
    response.writeHead(fail ? 500 : 200, { "Content-Type": "application/json" });
    response.write('{"ok":true');
  });
  const opening = ensureUrbitChannelOpen(deps, { createBody: [], createAuditContext: "test" });
  if (step === "success") {
    await opening;
  } else {
    await expect(opening).rejects.toThrow(`Channel ${step}`);
  }
  expect(puts).toBe(step === "creation" ? 1 : 2);
  await expect(deps.closed()).resolves.toBeUndefined();
});
it("closes unread scry failure bodies", async () => {
  const deps = await serve((_request, response) => {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.write('{"error":"unavailable"');
  });
  await expect(scryUrbitPath(deps, { path: PATH, auditContext: "test" })).rejects.toThrow(
    /Scry|503/,
  );
  await expect(deps.closed()).resolves.toBeUndefined();
});
it("reads a successful scry response over HTTP", async () => {
  await expect(
    scry((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"groups":{}}');
    }),
  ).resolves.toEqual({ groups: {} });
});
it("bounds poke error bodies at 16 KiB", async () => {
  const error = await poke((_request, response) => {
    response.writeHead(500, { "Content-Type": "text/plain" });
    streamBody(response, 4 * 1024 * 1024);
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(Buffer.byteLength(message, "utf8")).toBeLessThan(32 * 1024);
  expect(message).toContain("X");
});
it.each([
  ["Poke", true],
  ["Subscribe", true],
  ["Subscribe", false],
] as const)("redacts reflected %s cookies (JSON: %s)", async (operation, json) => {
  const deps = await serve((request, response) => {
    response.writeHead(500, { "Content-Type": json ? "application/json" : "text/plain" });
    response.end(
      json
        ? JSON.stringify({ error: "invalid session", cookie: request.headers.cookie })
        : `invalid session: ${request.headers.cookie}`,
    );
  });
  let error: unknown;
  if (operation === "Poke") {
    error = await pokeUrbitChannel(deps, {
      app: "test",
      mark: "test",
      json: {},
      auditContext: "test",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UrbitHttpError);
  } else {
    const client = new UrbitSSEClient(deps.baseUrl, COOKIE, deps);
    client.isConnected = true;
    const errors: unknown[] = [];
    await client.subscribe({ app: "test", path: "/test", err: (cause) => errors.push(cause) });
    expect(errors).toHaveLength(1);
    error = errors[0];
  }
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain(`${operation} failed: 500`);
  expect(message).toContain("invalid session");
  expect(message).not.toContain(COOKIE);
});
it("bounds streaming successful scry responses", async () => {
  await expect(
    scry((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"payload":"');
      streamBody(response, 18 * 1024 * 1024, '"}');
    }),
  ).rejects.toThrow(`Tlon scry response for path ${PATH}: JSON response exceeds 16777216 bytes`);
});
it("delivers an authenticated outbound message and closes its unread poke body", async () => {
  let observedCookie: string | undefined;
  const deps = await serve((request, response) => {
    if (request.method === "POST" && request.url === "/~/login") {
      response.writeHead(200, { "Set-Cookie": `${COOKIE}; Path=/; HttpOnly` }).end("ok");
    } else if (request.method === "PUT") {
      observedCookie = request.headers.cookie;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"accepted":true');
    } else {
      response.writeHead(404).end();
    }
  });
  const sendText = tlonRuntimeOutbound.sendText;
  if (!sendText) {
    throw new Error("expected the Tlon outbound text adapter");
  }
  const tlon = {
    ship: "~zod",
    url: deps.baseUrl,
    code: "proof",
    network: { dangerouslyAllowPrivateNetwork: true },
  };
  const result = await sendText({
    cfg: { channels: { tlon } } as OpenClawConfig,
    to: "~nec",
    text: "hello",
  });
  expect(result.channel).toBe("tlon");
  expect(result.messageId).toMatch(/^~zod\//);
  expect(result.receipt?.primaryPlatformMessageId).toBe(result.messageId);
  expect(observedCookie).toBe(COOKIE);
  await expect(deps.closed()).resolves.toBeUndefined();
});
