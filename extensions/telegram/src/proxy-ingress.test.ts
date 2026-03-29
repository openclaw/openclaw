import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const botInitMock = vi.hoisted(() => vi.fn(async () => undefined));
const botHandleUpdateMock = vi.hoisted(() => vi.fn(async () => undefined));
const createTelegramBotMock = vi.hoisted(() =>
  vi.fn(() => ({
    init: botInitMock,
    handleUpdate: botHandleUpdateMock,
    botInfo: { username: "test_bot" },
  })),
);

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
}));

vi.mock("./proxy.js", () => ({
  makeProxyFetch: vi.fn(),
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: vi.fn(),
}));

// ---------------------------------------------------------------------------

let clearIngressBotCache: typeof import("./proxy-ingress.js").clearIngressBotCache;
let createProxyIngressHandler: typeof import("./proxy-ingress.js").createProxyIngressHandler;
let setTelegramRuntime: typeof import("./runtime.js").setTelegramRuntime;
let clearTelegramRuntime: typeof import("./runtime.js").clearTelegramRuntime;

beforeAll(async () => {
  vi.resetModules();
  ({ clearIngressBotCache, createProxyIngressHandler } = await import("./proxy-ingress.js"));
  ({ setTelegramRuntime, clearTelegramRuntime } = await import("./runtime.js"));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installRuntime() {
  setTelegramRuntime({
    config: {
      loadConfig: () => ({
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "tok-default" },
              alt: { botToken: "tok-alt" },
            },
          },
        },
      }),
    },
  } as any);
}

function resetMocks() {
  botInitMock.mockReset();
  botInitMock.mockImplementation(async () => undefined);
  botHandleUpdateMock.mockReset();
  botHandleUpdateMock.mockImplementation(async () => undefined);
  createTelegramBotMock.mockReset();
  createTelegramBotMock.mockImplementation(() => ({
    init: botInitMock,
    handleUpdate: botHandleUpdateMock,
    botInfo: { username: "test_bot" },
  }));
}

function makeReq(
  method: string,
  url: string,
  body?: unknown,
): { req: IncomingMessage; write: () => void } {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };
  return {
    req,
    write() {
      if (body !== undefined) {
        stream.end(JSON.stringify(body));
      } else {
        stream.end();
      }
    },
  };
}

function makeRes(): {
  res: ServerResponse;
  result: () => { status: number; body: string };
} {
  let written = "";
  let status = 200;
  const res = {
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      written = data ?? "";
    }),
  } as unknown as ServerResponse;

  Object.defineProperty(res, "statusCode", {
    get: () => status,
    set: (v: number) => {
      status = v;
    },
  });

  return {
    res,
    result: () => ({ status, body: written }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxy-ingress handler", () => {
  let handler: Awaited<ReturnType<typeof createProxyIngressHandler>>;

  beforeEach(() => {
    resetMocks();
    clearIngressBotCache();
    installRuntime();
    handler = createProxyIngressHandler({} as any);
  });

  afterEach(() => {
    clearTelegramRuntime();
  });

  it("ignores non-matching routes", async () => {
    const { req, write } = makeReq("POST", "/api/channels/telegram/webhook");
    const { res } = makeRes();
    write();
    const handled = await handler(req, res);
    expect(handled).toBe(false);
  });

  it("rejects non-POST methods", async () => {
    const { req, write } = makeReq("GET", "/api/channels/telegram/proxy-ingress");
    const { res, result } = makeRes();
    write();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(result().status).toBe(405);
  });

  it("rejects empty body", async () => {
    const { req, write } = makeReq("POST", "/api/channels/telegram/proxy-ingress");
    const { res, result } = makeRes();
    write();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(result().status).toBe(400);
  });

  it("rejects non-object body", async () => {
    const { req, write } = makeReq("POST", "/api/channels/telegram/proxy-ingress", "hello");
    const { res, result } = makeRes();
    write();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(result().status).toBe(400);
    expect(result().body).toContain("JSON object");
  });

  it("accepts valid update and calls handleUpdate", async () => {
    const update = { update_id: 1, message: { chat: { id: 123 }, text: "hi" } };
    const { req, write } = makeReq("POST", "/api/channels/telegram/proxy-ingress", update);
    const { res, result } = makeRes();
    write();

    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(result().status).toBe(200);
    expect(JSON.parse(result().body)).toEqual({ ok: true });
    expect(botHandleUpdateMock).toHaveBeenCalledWith(update);
  });

  it("initializes bot via init() on first request", async () => {
    const update = { update_id: 2 };
    const { req, write } = makeReq("POST", "/api/channels/telegram/proxy-ingress", update);
    const { res } = makeRes();
    write();

    await handler(req, res);
    expect(createTelegramBotMock).toHaveBeenCalledTimes(1);
    expect(botInitMock).toHaveBeenCalledTimes(1);
  });

  it("caches bot instances across requests", async () => {
    const update = { update_id: 3 };

    const r1 = makeReq("POST", "/api/channels/telegram/proxy-ingress", update);
    const res1 = makeRes();
    r1.write();
    await handler(r1.req, res1.res);

    const r2 = makeReq("POST", "/api/channels/telegram/proxy-ingress", update);
    const res2 = makeRes();
    r2.write();
    await handler(r2.req, res2.res);

    expect(createTelegramBotMock).toHaveBeenCalledTimes(1);
    expect(botInitMock).toHaveBeenCalledTimes(1);
    expect(botHandleUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("uses account query param", async () => {
    const update = { update_id: 4 };
    const { req, write } = makeReq(
      "POST",
      "/api/channels/telegram/proxy-ingress?account=alt",
      update,
    );
    const { res, result } = makeRes();
    write();

    await handler(req, res);
    expect(result().status).toBe(200);
    expect(createTelegramBotMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok-alt", accountId: "alt" }),
    );
  });

  it("returns 500 when handleUpdate throws", async () => {
    botHandleUpdateMock.mockRejectedValueOnce(new Error("boom"));
    const update = { update_id: 5, message: { chat: { id: 1 }, text: "x" } };
    const { req, write } = makeReq("POST", "/api/channels/telegram/proxy-ingress", update);
    const { res, result } = makeRes();
    write();

    await handler(req, res);
    expect(result().status).toBe(500);
    expect(result().body).toContain("Failed to process update");
  });

  it("rejects invalid JSON body", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    req.method = "POST";
    req.url = "/api/channels/telegram/proxy-ingress";
    req.headers = { host: "localhost" };
    const { res, result } = makeRes();

    stream.end("not-json{{{");
    await handler(req, res);
    expect(result().status).toBe(400);
    expect(result().body).toContain("invalid JSON");
  });
});
