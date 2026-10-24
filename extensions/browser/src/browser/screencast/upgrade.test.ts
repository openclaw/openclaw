import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screencastParams } from "./test-support.js";
import * as tokens from "./tokens.js";
import { handleBrowserScreencastUpgrade } from "./upgrade.js";

const mocks = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("./session.js", () => ({ attachBrowserScreencastViewer: mocks.attach }));

describe("browser screencast WebSocket upgrade", () => {
  let server: Server;
  let url: string;
  let clients: WebSocket[];

  beforeEach(async () => {
    mocks.attach.mockReset();
    clients = [];
    server = createServer().on("upgrade", (req, socket, head) => {
      void handleBrowserScreencastUpgrade(req, socket, head);
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/browser/screencast`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clients.forEach((client) => client.terminate());
    mocks.attach.mock.calls.forEach(([, viewer]) => (viewer as WebSocket).terminate());
    await promisify(server.close.bind(server))();
    tokens.clearBrowserScreencastTokens();
  });

  function connect(token: string, autoPong = true): WebSocket {
    const ws = new WebSocket(`${url}?token=${token}`, { autoPong });
    clients.push(ws);
    return ws;
  }

  async function rejected(token: string): Promise<number | undefined> {
    const ws = connect(token);
    return await new Promise((resolve) => {
      ws.once("open", () => resolve(undefined));
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        ws.on("error", () => {});
        ws.terminate();
        resolve(response.statusCode);
      });
    });
  }

  it("accepts a minted token once and rejects invalid or reused tokens with HTTP 401", async () => {
    expect(await rejected("invalid")).toBe(401);
    const params = screencastParams();
    const token = tokens.mintBrowserScreencastToken(params).token;
    const ws = connect(token);
    await once(ws, "open");
    expect(mocks.attach).toHaveBeenCalledWith(params, expect.any(WebSocket), undefined);
    expect(await rejected(token)).toBe(401);
  });

  it.each(["abort", "invalidate"])("rejects a ticket on requester %s", async (mode) => {
    const requester = new AbortController();
    let current = true;
    const { token } = tokens.mintBrowserScreencastToken(
      screencastParams({
        requesterSignal: requester.signal,
        isRequesterCurrent: () => current,
      }),
    );
    if (mode === "abort") {
      const consume = tokens.consumeBrowserScreencastToken;
      vi.spyOn(tokens, "consumeBrowserScreencastToken").mockImplementationOnce((value) => {
        const params = consume(value);
        requester.abort();
        return params;
      });
    } else {
      current = false;
      expect(requester.signal.aborted).toBe(false);
    }
    expect(await rejected(token)).toBe(401);
    if (mode === "invalidate") {
      current = true;
      expect(await rejected(token)).toBe(401);
    }
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("rejects binary input on the view-only socket", async () => {
    const ws = connect(tokens.mintBrowserScreencastToken(screencastParams()).token);
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send(Buffer.from([1]));
    expect(await closed).toEqual([1003, Buffer.from("view_only")]);
  });

  it("pings viewers and terminates a missed pong", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const ws = connect(tokens.mintBrowserScreencastToken(screencastParams()).token, false);
    await once(ws, "open");
    const ping = once(ws, "ping");
    await vi.advanceTimersByTimeAsync(25_000);
    await ping;
    const closed = once(ws, "close");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await closed).toEqual([1006, Buffer.alloc(0)]);
  });
});
