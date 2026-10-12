import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse, type RequestListener } from "node:http";
import { Socket } from "node:net";
import type { ClientOptions } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const transport = vi.hoisted(() => ({
  server: undefined as EventEmitter | undefined,
  handler: undefined as RequestListener | undefined,
  fetch: vi.fn(),
  resolve: vi.fn(),
  proxyAgent: vi.fn(),
  dial: vi.fn(),
  lookup: vi.fn(),
  pinned: undefined as typeof import("node:dns").lookup | undefined,
  afterDns: undefined as (() => void) | undefined,
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer(handler: RequestListener) {
      const server = Object.assign(new EventEmitter(), {
        listen: (_port: number, _host: string, ready: () => void) => ready(),
        address: () => ({ port: 12345 }),
        close: () => {},
        closeAllConnections: () => {},
      });
      transport.server = server;
      transport.handler = handler;
      return server;
    },
  };
});
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  createNodeProxyAgent: transport.proxyAgent,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: transport.fetch,
    resolvePinnedHostnameWithPolicy: transport.resolve.mockImplementation(
      async (hostname, params) => {
        const pinned = await actual.resolvePinnedHostnameWithPolicy(hostname, {
          ...params,
          lookupFn: transport.lookup,
        });
        transport.pinned = pinned.lookup;
        transport.afterDns?.();
        return pinned;
      },
    ),
  };
});
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: class extends EventEmitter {
      constructor(url: URL, options: ClientOptions) {
        super();
        transport.dial(String(url), options);
        // Stop at the transport boundary: never open any upstream socket.
        queueMicrotask(() => this.emit("error", new Error("synthetic end of handshake")));
      }
      terminate() {}
    },
  };
});

const policy = {
  hostnameAllowlist: ["chatgpt.com"],
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
};
const fakeAddresses = ["198.18.0.1", "198.19.255.254", "fc00::1", "fdff::1234"];
const blockedAddresses = [
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.1.1",
  "169.254.169.254",
  "::1",
  "fe80::1",
  "fd00:ec2::254",
];
let proxy: CodexInferenceProxy | undefined;
let current: boolean;

beforeEach(() => {
  transport.fetch.mockReset();
  transport.resolve.mockClear();
  transport.proxyAgent.mockReset();
  transport.dial.mockReset();
  transport.lookup.mockReset();
  transport.pinned = undefined;
  transport.afterDns = undefined;
  current = true;
});
afterEach(() => proxy?.close());

async function fixture(upstream = "https://chatgpt.com/backend-api/codex") {
  proxy = await createCodexInferenceProxy({
    upstream: new URL(upstream),
    assertCurrent: () => {
      if (!current) {
        throw new Error("synthetic revoked owner");
      }
    },
  });
  return proxy;
}

function dns(addresses: string[]) {
  transport.lookup.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
}

function socket() {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events = new EventEmitter();
  const value = Object.assign(events, {
    closed: false,
    destroyed: false,
    writableEnded: false,
    destroy() {
      this.closed = this.destroyed = true;
      events.emit("close");
      finish();
    },
    end(_body: unknown, callback?: () => void) {
      this.writableEnded = true;
      callback?.();
      this.destroy();
    },
  });
  return { value, closed };
}

async function http() {
  if (!proxy || !transport.handler) {
    throw new Error("fixture not prepared");
  }
  const body = JSON.stringify({
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: "child",
        parent_thread_id: "root",
      }),
    },
  });
  // Only the Node request/response boundary is synthetic; dispatch, admission,
  // upload streams, guarded fetch and DNS classification remain production code.
  const req = new IncomingMessage(new Socket());
  req.url = new URL(proxy.baseUrl).pathname + "/responses";
  req.method = "POST";
  req.complete = true;
  req.push(Buffer.from(body));
  req.push(null);
  let status = 200;
  let done!: (status: number) => void;
  const completed = new Promise<number>((resolve) => {
    done = resolve;
  });
  const res = new ServerResponse(req);
  vi.spyOn(res, "writeHead").mockImplementation((code: number) => {
    status = code;
    return res;
  });
  vi.spyOn(res, "end").mockImplementation(() => {
    req.socket.destroy();
    done(status);
    return res;
  });
  vi.spyOn(res, "destroy").mockImplementation(() => {
    req.socket.destroy();
    done(status);
    return res;
  });
  transport.handler(req, res);
  return completed;
}

async function ws() {
  if (!proxy || !transport.server) {
    throw new Error("fixture not prepared");
  }
  const connection = socket();
  transport.server.emit(
    "upgrade",
    {
      url: new URL(proxy.baseUrl).pathname + "/responses",
      headers: {},
    },
    connection.value,
    Buffer.alloc(0),
  );
  await connection.closed;
}

async function guardedHttp(response = new Response(null, { status: 204 })) {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  const send = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Response(init?.body).arrayBuffer();
    return response;
  });
  transport.fetch.mockImplementation((params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
    actual.fetchWithSsrFGuard({
      ...params,
      lookupFn: transport.lookup,
      dispatcherPolicy: { mode: "direct" },
      fetchImpl: send,
    }),
  );
  return send;
}

describe("Codex inference fake-IP policy", () => {
  it.each(fakeAddresses)("forwards HTTP and pins direct WebSocket DNS for %s", async (address) => {
    await fixture();
    dns([address]);
    const send = await guardedHttp();
    expect(await http()).toBe(204);
    expect(send).toHaveBeenCalledOnce();
    const args = transport.fetch.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      policy,
      requireHttps: true,
      maxRedirects: 0,
      capture: false,
      mode: "trusted_env_proxy",
      auditContext: "codex-parent-local-inference",
      init: { method: "POST", duplex: "half" },
      beforeRequest: expect.any(Function),
    });
    expect(args.signal).toBe(args.init.signal);
    expect(args).not.toHaveProperty("pinDns");
    await ws();
    expect(transport.resolve).toHaveBeenCalledWith("chatgpt.com", {
      policy,
      signal: expect.any(AbortSignal),
    });
    expect(transport.dial).toHaveBeenCalledWith(
      "wss://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({ lookup: transport.pinned, followRedirects: false }),
    );
    const pinned = transport.pinned;
    if (!pinned) {
      throw new Error("missing pinned DNS");
    }
    dns(["127.0.0.1"]);
    await expect(
      new Promise((resolve, reject) => {
        pinned("chatgpt.com", { all: true }, (error, answers) =>
          error ? reject(error) : resolve(answers),
        );
      }),
    ).resolves.toEqual([{ address, family: address.includes(":") ? 6 : 4 }]);
    expect(transport.lookup).toHaveBeenCalledTimes(2);
  });

  it.each(blockedAddresses)(
    "still rejects HTTP and WebSocket DNS answers containing %s",
    async (address) => {
      await fixture();
      dns(["198.18.0.1", address]);
      const send = await guardedHttp();
      expect(await http()).toBe(502);
      expect(send).not.toHaveBeenCalled();
      await ws();
      expect(transport.dial).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://api.openai.com/v1",
    "https://sub.chatgpt.com/v1",
    "https://chatgpt.com:8443/v1",
    "https://chatgpt.com.example/v1",
  ])("keeps default checks for %s", async (upstream) => {
    await fixture(upstream);
    dns(["198.18.0.1"]);
    const send = await guardedHttp();
    expect(await http()).toBe(502);
    expect(transport.fetch.mock.calls[0]?.[0].policy).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await ws();
    expect(transport.resolve.mock.calls[0]?.[1].policy).toBeUndefined();
    expect(transport.dial).not.toHaveBeenCalled();
  });

  it.each([
    "http://chatgpt.com/v1",
    "https://user@chatgpt.com/v1",
    "https://user:pass@chatgpt.com/v1",
  ])("rejects invalid upstream %s before transport", async (upstream) => {
    await expect(fixture(upstream)).rejects.toThrow("credential-free HTTPS");
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("does not follow HTTP redirects with the fake-IP allowance", async () => {
    await fixture();
    dns(["198.18.0.1"]);
    const send = await guardedHttp(
      new Response(null, { status: 307, headers: { location: "https://example.com/responses" } }),
    );
    expect(await http()).toBe(502);
    expect(send).toHaveBeenCalledOnce();
  });

  it("preserves environment proxy ownership instead of resolving destination DNS", async () => {
    await fixture();
    const agent = { destroy: vi.fn() };
    transport.proxyAgent.mockReturnValue(agent);
    await ws();
    expect(transport.proxyAgent).toHaveBeenCalledWith({
      mode: "env",
      targetUrl: "https://chatgpt.com/backend-api/codex/responses",
    });
    expect(transport.resolve).not.toHaveBeenCalled();
    expect(transport.dial.mock.calls[0]?.[1]).toMatchObject({ agent, followRedirects: false });
    expect(transport.dial.mock.calls[0]?.[1]).not.toHaveProperty("lookup");
    expect(agent.destroy).toHaveBeenCalledOnce();
  });

  it("revalidates the owner after direct WebSocket DNS preparation", async () => {
    await fixture();
    dns(["198.18.0.1"]);
    transport.afterDns = () => {
      current = false;
    };
    await ws();
    expect(transport.pinned).toBeTypeOf("function");
    expect(transport.dial).not.toHaveBeenCalled();
  });

  it("revalidates HTTP authorization at physical I/O", async () => {
    await fixture();
    dns(["198.18.0.1"]);
    transport.lookup.mockImplementation(async () => {
      current = false;
      return [{ address: "198.18.0.1", family: 4 }];
    });
    const send = await guardedHttp();
    expect(await http()).toBe(502);
    expect(send).not.toHaveBeenCalled();
  });
});
