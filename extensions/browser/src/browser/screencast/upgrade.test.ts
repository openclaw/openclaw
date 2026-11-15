import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screencastParams } from "./test-support.js";
import * as tokens from "./tokens.js";
import { handleBrowserScreencastUpgrade } from "./upgrade.js";

const mocks = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("./session.js", () => ({ attachBrowserScreencastViewer: mocks.attach }));
const mint = (overrides: Parameters<typeof screencastParams>[0] = {}) =>
  tokens.mintBrowserScreencastToken(screencastParams(overrides)).token;

let server: Server;
let url: string;
const clients: WebSocket[] = [];
beforeEach(async () => {
  mocks.attach.mockReset();
  server = createServer().on("upgrade", (req, socket, head) => {
    void handleBrowserScreencastUpgrade(req, socket, head);
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/browser/screencast`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clients.splice(0).forEach((client) => client.terminate());
  mocks.attach.mock.calls.forEach(([, viewer]) => (viewer as WebSocket).terminate());
  await server[Symbol.asyncDispose]();
  tokens.clearBrowserScreencastTokens();
});

function connect(token: string, autoPong = true): WebSocket {
  const ws = new WebSocket(`${url}?token=${token}`, { autoPong });
  clients.push(ws);
  return ws;
}

async function rejected(token: string): Promise<number | undefined> {
  const ws = connect(token);
  const [, res] = await Promise.race([once(ws, "unexpected-response"), once(ws, "open")]);
  res?.resume();
  ws.on("error", () => {});
  ws.terminate();
  return res?.statusCode;
}

it("accepts a one-use view-only token and rejects invalid or reused tokens with HTTP 401", async () => {
  expect(await rejected("invalid")).toBe(401);
  const params = screencastParams();
  const token = tokens.mintBrowserScreencastToken(params).token;
  const ws = connect(token);
  await once(ws, "open");
  expect(mocks.attach).toHaveBeenCalledWith(params, expect.any(WebSocket), undefined);
  expect(await rejected(token)).toBe(401);
  const closed = once(ws, "close");
  ws.send(Buffer.from([1]));
  expect(await closed).toEqual([1003, Buffer.from("view_only")]);
});

it.each(["abort", "invalidate"])("rejects a ticket on requester %s", async (mode) => {
  const requester = new AbortController();
  let current = true;
  const token = mint({ requesterSignal: requester.signal, isRequesterCurrent: () => current });
  current = mode === "abort";
  if (mode === "abort") {
    const consume = tokens.consumeBrowserScreencastToken;
    vi.spyOn(tokens, "consumeBrowserScreencastToken").mockImplementationOnce((value) => {
      const params = consume(value);
      requester.abort();
      return params;
    });
  }
  expect(await rejected(token)).toBe(401);
  current = true;
  expect(await rejected(token)).toBe(401);
  expect(mocks.attach).not.toHaveBeenCalled();
});

it("pings viewers and terminates a missed pong", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const ws = connect(mint(), false);
  await once(ws, "open");
  const ping = once(ws, "ping");
  await vi.advanceTimersByTimeAsync(25_000);
  await ping;
  const closed = once(ws, "close");
  await vi.advanceTimersByTimeAsync(25_000);
  expect(await closed).toEqual([1006, Buffer.alloc(0)]);
});
