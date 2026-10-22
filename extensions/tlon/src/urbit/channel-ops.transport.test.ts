import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import { tlonRuntimeOutbound } from "../channel.runtime.js";
import { ensureUrbitChannelOpen, scryUrbitPath } from "./channel-ops.js";

let server: ReturnType<typeof createServer>;
afterEach(async () => {
  await promisify(server.close.bind(server))();
});
async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, onClose: () => void) => void,
) {
  let onClose = () => {};
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  server = createServer((request, response) => handler(request, response, onClose));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, closed };
}
const channelDeps = (baseUrl: string) => ({
  baseUrl,
  cookie: "urbauth-~zod=proof",
  ship: "zod",
  channelId: "channel-proof",
  ssrfPolicy: { allowPrivateNetwork: true },
});

it("cancels unread create/wake bodies and closes the request socket", async () => {
  let putCount = 0;
  const { baseUrl, closed } = await startServer((request, response, onClose) => {
    if (request.method !== "PUT") {
      response.writeHead(404);
      response.end();
      return;
    }
    putCount += 1;
    request.socket.once("close", () => {
      // Assert against the first (create) PUT; wake also cancels.
      if (putCount === 1) {
        onClose();
      }
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"ok":true');
  });
  await ensureUrbitChannelOpen(channelDeps(baseUrl), {
    createBody: [],
    createAuditContext: "tlon-channel-ops-create-proof",
  });
  expect(putCount).toBeGreaterThanOrEqual(1);
  await expect(closed).resolves.toBeUndefined();
});

it("cancels unread scry failure bodies and closes the request socket", async () => {
  const { baseUrl, closed } = await startServer((request, response, onClose) => {
    request.socket.once("close", onClose);
    response.writeHead(503, { "Content-Type": "application/json" });
    response.write('{"error":"unavailable"');
  });
  await expect(
    scryUrbitPath(channelDeps(baseUrl), {
      path: "/chat/inbox.json",
      auditContext: "tlon-scry-proof",
    }),
  ).rejects.toThrow(/Scry|503/);
  await expect(closed).resolves.toBeUndefined();
});

it("delivers an authenticated outbound message and closes its unread poke body", async () => {
  const expectedCookie = "urbauth-~zod=outbound-proof";
  let observedCookie: string | undefined;
  const { baseUrl, closed } = await startServer((request, response, onClose) => {
    if (request.method === "POST" && request.url === "/~/login") {
      response.writeHead(200, { "Set-Cookie": `${expectedCookie}; Path=/; HttpOnly` });
      response.end("ok");
      return;
    }
    if (request.method === "PUT") {
      observedCookie = request.headers.cookie;
      request.socket.once("close", onClose);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"accepted":true');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const sendText = tlonRuntimeOutbound.sendText;
  if (!sendText) {
    throw new Error("expected the Tlon outbound text adapter");
  }
  const tlon = {
    ship: "~zod",
    url: baseUrl,
    code: "outbound-proof",
    network: { dangerouslyAllowPrivateNetwork: true },
  };
  const result = await sendText({
    cfg: { channels: { tlon } } as OpenClawConfig,
    to: "~nec",
    text: "hello from the real outbound adapter",
  });

  expect(result.channel).toBe("tlon");
  expect(result.messageId).toMatch(/^~zod\//);
  expect(result.receipt?.primaryPlatformMessageId).toBe(result.messageId);
  expect(observedCookie).toBe(expectedCookie);
  await expect(closed).resolves.toBeUndefined();
});
