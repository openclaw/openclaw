import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitHttpError } from "./errors.js";
import { UrbitSSEClient } from "./sse-client.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, { ...params.init, signal: params.signal }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

const { pokeUrbitChannel, scryUrbitPath } = await import("./channel-ops.js");
const CHUNK = Buffer.alloc(64 * 1024, "X");
const SCRY_PATH = "/groups-ui/v6/init.json";
const COOKIE = "urbauth-~zod=0v1g.abcde.ijklm.prst";

function streamBody(res: http.ServerResponse, size: number, suffix = "") {
  let written = 0;
  const write = () => {
    if (res.destroyed) {
      return;
    }
    if (written >= size) {
      res.end(suffix);
      return;
    }
    written += CHUNK.length;
    if (res.write(CHUNK)) {
      setImmediate(write);
    } else {
      res.once("drain", write);
    }
  };
  write();
}

describe("tlon error body boundary", () => {
  let server: http.Server;
  async function serve(handler: http.RequestListener) {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      cookie: COOKIE,
      ship: "~zod",
      channelId: "test",
    };
  }
  async function poke(handler: http.RequestListener) {
    return pokeUrbitChannel(await serve(handler), {
      app: "test",
      mark: "test",
      json: {},
      auditContext: "test",
    }).catch((e: unknown) => e);
  }
  async function scry(handler: http.RequestListener) {
    return scryUrbitPath(await serve(handler), { path: SCRY_PATH, auditContext: "test" });
  }
  function reflectedCookie(json: boolean): http.RequestListener {
    return (req, res) => {
      res.writeHead(500, { "Content-Type": json ? "application/json" : "text/plain" });
      res.end(
        json
          ? JSON.stringify({ error: "invalid session", cookie: req.headers.cookie })
          : `invalid session: ${req.headers.cookie}`,
      );
    };
  }
  function expectRedacted(error: unknown, operation: string) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain(`${operation} failed: 500`);
    expect(message).toContain("invalid session");
    expect(message).not.toContain(COOKIE);
  }
  async function subscribe(json: boolean) {
    const { baseUrl } = await serve(reflectedCookie(json));
    const client = new UrbitSSEClient(baseUrl, COOKIE, { ship: "~zod" });
    client.isConnected = true;
    const errors: unknown[] = [];
    await client.subscribe({ app: "test", path: "/test", err: (error) => errors.push(error) });
    expect(errors).toHaveLength(1);
    expectRedacted(errors[0], "Subscribe");
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it("bounds poke error body at 16 KiB", async () => {
    const err = await poke((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      streamBody(res, 4 * 1024 * 1024);
    });
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(Buffer.byteLength(msg, "utf8")).toBeLessThan(32 * 1024);
    expect(msg).toContain("X");
  });
  it("redacts a reflected session cookie from poke error bodies", async () => {
    const err = await poke(reflectedCookie(true));
    expect(err).toBeInstanceOf(UrbitHttpError);
    expectRedacted(err, "Poke");
  });
  it("redacts a bare reflected session cookie from poke error bodies", async () => {
    const err = await poke(reflectedCookie(false));
    expect(err).toBeInstanceOf(UrbitHttpError);
    expectRedacted(err, "Poke");
  });
  it("redacts a bare reflected session cookie from subscribe error bodies", async () => {
    await subscribe(false);
  });
  it("redacts a reflected session cookie from subscribe error JSON", async () => {
    await subscribe(true);
  });
  it("parses a normal scry response over HTTP", async () => {
    await expect(
      scry((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ groups: {} }));
      }),
    ).resolves.toEqual({ groups: {} });
  });
  it("bounds a streaming successful scry response over HTTP", async () => {
    const error = await scry((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"payload":"');
      streamBody(res, 18 * 1024 * 1024, '"}');
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Tlon scry response for path ${SCRY_PATH}: JSON response exceeds 16777216 bytes`,
    );
  });
});
