import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, Socket } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createMockIncomingRequest, withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelegramMiniApp } from "../../miniapp-api.js";
import {
  createTelegramMiniAppLaunchTickets,
  type TelegramMiniAppLaunchTickets,
} from "./launch-ticket.js";

type OpenClawPluginHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

const issueDeviceBootstrapToken = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/device-bootstrap").issueDeviceBootstrapToken>(
    async () => ({
      token: "issued",
      expiresAtMs: Date.now() + 600_000,
    }),
  ),
);
const resolveTelegramMiniAppUrls = vi.hoisted(() =>
  vi.fn(async () => ({
    pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
    controlUiUrl: "https://host.tailnet.ts.net/openclaw",
    gatewayUrl: "wss://host.tailnet.ts.net",
  })),
);

vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  issueDeviceBootstrapToken,
}));

vi.mock("./url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./url.js")>()),
  resolveTelegramMiniAppUrls,
}));

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

const { registerTelegramMiniAppRoutes } = await import("./routes.js");

const BOT_TOKEN = "fixture";
const AUTH_BODY_MAX_BYTES = 4096;
let signedNonceSequence = 0;
let launchTickets: TelegramMiniAppLaunchTickets;

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  end(body?: string) {
    this.body = body ?? "";
    this.emit("finish");
    return this;
  }
}

function createRoute(
  cfg: OpenClawConfig,
  currentConfig?: () => OpenClawConfig,
): OpenClawPluginHttpRouteParams {
  let route: OpenClawPluginHttpRouteParams | null = null;
  const api = createTestPluginApi({
    config: cfg,
    registerHttpRoute(params) {
      route = params;
    },
  });
  if (currentConfig) {
    api.runtime.config = {
      current: currentConfig,
      mutateConfigFile: vi.fn(),
      replaceConfigFile: vi.fn(),
    };
  }
  registerTelegramMiniAppRoutes(api, launchTickets);
  if (!route) {
    throw new Error("expected miniapp route registration");
  }
  return route;
}

async function callRoute(params: {
  route: OpenClawPluginHttpRouteParams;
  method: string;
  url: string;
  body?: string;
  contentType?: string;
  ip?: string;
}) {
  const req = createMockIncomingRequest(params.body ? [params.body] : []);
  req.method = params.method;
  req.url = params.url;
  req.headers = params.contentType ? { "content-type": params.contentType } : {};
  Object.defineProperty(req.socket, "remoteAddress", {
    value: params.ip ?? "203.0.113.10",
  });
  return await callRouteRequest(params.route, req);
}

async function callRouteRequest(route: OpenClawPluginHttpRouteParams, req: IncomingMessage) {
  const res = new MockResponse() as ServerResponse & MockResponse;
  await route.handler(req, res);
  return res;
}

function createPendingAuthRequest(ip: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/__openclaw_tg_miniapp/auth";
  req.headers = { "content-type": "application/json" };
  Object.defineProperty(req.socket, "remoteAddress", { value: ip });
  return req;
}

function expectBodyReadListenersCleaned(req: IncomingMessage) {
  for (const event of ["data", "end", "error", "close"] as const) {
    expect(req.listenerCount(event), event).toBe(0);
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return address.port;
}

async function readSocketResponse(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });
}

function config(allowFrom: string[] = ["123456"]): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: BOT_TOKEN,
        allowFrom,
      },
    },
    gateway: { tailscale: { mode: "funnel" } },
  };
}

function signedInitData(userId: string, nonce: string): string {
  signedNonceSequence += 1;
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `${nonce}-${signedNonceSequence}`,
    user: JSON.stringify({ id: Number(userId), first_name: "Ayaan" }),
  });
  const entries = [...params.entries()].map(([key, value]) => `${key}=${value}`).toSorted();
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(entries.join("\n")).digest("hex"));
  return params.toString();
}

function authBody(params: { userId?: string; nonce: string; accountId?: string }): string {
  const userId = params.userId ?? "123456";
  const accountId = params.accountId ?? "default";
  return JSON.stringify({
    initData: signedInitData(userId, params.nonce),
    accountId,
    launchTicket: launchTickets.issue({ accountId, userId }),
  });
}

describe("registerTelegramMiniAppRoutes", () => {
  beforeEach(() => {
    launchTickets = createTelegramMiniAppLaunchTickets();
    issueDeviceBootstrapToken.mockClear();
    resolveTelegramMiniAppUrls.mockClear();
  });

  it("serves the page without resolving published URLs", async () => {
    const route = createRoute({});
    const res = await callRoute({
      route,
      method: "GET",
      url: "/__openclaw_tg_miniapp/?accountId=ops",
    });

    expect(res.statusCode).toBe(200);
    expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
  });

  it("recovers wildcard-only Control UI access with an explicit owner ID and rejects group launches", async () => {
    const allowFrom = ["accessGroup:operators"];
    const cfg: OpenClawConfig = {
      accessGroups: {
        operators: { type: "message.senders", members: { telegram: ["*"] } },
      },
      channels: {
        telegram: {
          botToken: BOT_TOKEN,
          allowFrom: ["999999"],
          accounts: { ops: { allowFrom } },
        },
      },
      gateway: { tailscale: { mode: "funnel" } },
    };
    const commands: OpenClawPluginCommandDefinition[] = [];
    const routes: OpenClawPluginHttpRouteParams[] = [];
    registerTelegramMiniApp(
      createTestPluginApi({
        config: cfg,
        registerCommand: (command) => commands.push(command),
        registerHttpRoute: (route) => routes.push(route),
      }),
    );
    const command = commands.find((entry) => entry.name === "controlui");
    const route = routes.find((entry) => entry.path === "/__openclaw_tg_miniapp/");
    if (!command || !route) {
      throw new Error("expected registered Mini App command and route");
    }
    const context: PluginCommandContext = {
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: false,
      commandBody: "/controlui",
      config: cfg,
      accountId: "ops",
      from: "telegram:123456",
      sessionKey: "telegram:direct:123456",
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    };

    const groupReply = await command.handler({
      ...context,
      from: "telegram:group:-100",
      sessionKey: "telegram:group:-100",
      senderIsOwner: true,
    });
    expect(groupReply.text).toContain("DM");
    expect(groupReply.presentation).toBeUndefined();
    expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();

    const deniedReply = await command.handler(context);
    expect(deniedReply.text).toContain("administrator");
    expect(deniedReply.text).toContain("numeric Telegram user ID (123456)");
    expect(deniedReply.text).toContain("allowFrom");
    expect(deniedReply.text).toContain("commands.ownerAllowFrom");
    expect(deniedReply.text).toContain("retry /controlui");
    expect(deniedReply.presentation).toBeUndefined();
    expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();

    allowFrom.push("123456");
    const reply = await command.handler(context);
    const buttons = reply.presentation?.blocks.find((block) => block.type === "buttons");
    const webAppUrl = buttons?.buttons[0]?.webApp?.url;
    if (!webAppUrl) {
      throw new Error("expected an owner DM Web App launch URL");
    }
    const launchUrl = new URL(webAppUrl);
    const launchTicket = new URLSearchParams(launchUrl.hash.slice(1)).get("launchTicket");
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        initData: signedInitData("123456", "registered-command"),
        accountId: launchUrl.searchParams.get("accountId"),
        launchTicket,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      bootstrapToken: "issued",
      controlUiUrl: "https://host.tailnet.ts.net/openclaw",
      gatewayUrl: "wss://host.tailnet.ts.net",
    });
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledWith({
      assertCurrent: expect.any(Function),
      profile: {
        roles: ["operator"],
        scopes: [
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        purpose: "control-ui",
      },
    });
  });

  it.each(
    (["account", "command"] as const).flatMap((source) =>
      (["*", "telegram"] as const).flatMap((channel) =>
        [
          { members: ["*"], allowed: false },
          { members: ["@owner", "999999"], allowed: false },
          { members: ["telegram:123456"], allowed: true },
          { members: ["*", "tg:123456"], allowed: true },
        ].map(({ members, allowed }) => ({ source, channel, members, allowed })),
      ),
    ),
  )(
    "requires explicit group ownership: $source / $channel / $members",
    async ({ source, channel, members, allowed }) => {
      const cfg = config([]);
      cfg.accessGroups = {
        operators: { type: "message.senders", members: { [channel]: members } },
      };
      if (source === "account") {
        cfg.channels = {
          telegram: {
            botToken: BOT_TOKEN,
            accounts: { ops: { allowFrom: ["accessGroup:operators"] } },
          },
        };
      } else {
        cfg.commands = { ownerAllowFrom: ["accessGroup:operators"] };
      }
      const commands: OpenClawPluginCommandDefinition[] = [];
      registerTelegramMiniApp(
        createTestPluginApi({
          config: cfg,
          registerCommand: (command) => commands.push(command),
        }),
      );
      const command = commands.find((entry) => entry.name === "controlui");
      if (!command) {
        throw new Error("expected registered Mini App command");
      }
      const reply = await command.handler({
        channel: "telegram",
        isAuthorizedSender: true,
        senderIsOwner: true,
        commandBody: "/controlui",
        config: cfg,
        accountId: "ops",
        from: "telegram:123456",
        sessionKey: "telegram:direct:123456",
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      });
      if (allowed) {
        expect(reply.presentation?.blocks).toEqual([expect.objectContaining({ type: "buttons" })]);
      } else {
        expect(reply.text).toContain("Restricted to the bot owner.");
        expect(reply.presentation).toBeUndefined();
      }

      // A previously issued ticket must not bypass the auth route's owner check.
      const res = await callRoute({
        route: createRoute(cfg),
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: authBody({ accountId: "ops", nonce: "group-owner" }),
        ip: `203.0.113.${100 + signedNonceSequence}`,
      });
      expect(res.statusCode).toBe(allowed ? 200 : 403);
      expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (!allowed) {
        expect(res.body).toBe("Restricted to the bot owner.");
      }
    },
  );

  it.each([
    "body",
    "published URL",
    "bot token",
    "credential",
    "credential response",
    "unchanged",
  ] as const)("keeps owner authority current across the %s await", async (stage) => {
    let currentConfig = config();
    const route = createRoute(currentConfig, () => currentConfig);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let persistedTokens: number | undefined;
    if (stage === "published URL" || stage === "bot token") {
      resolveTelegramMiniAppUrls.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return {
          pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
          controlUiUrl: "https://host.tailnet.ts.net/openclaw",
          gatewayUrl: "wss://host.tailnet.ts.net",
        };
      });
    } else if (stage === "credential response") {
      issueDeviceBootstrapToken.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return { token: "issued", expiresAtMs: Date.now() + 600_000 };
      });
    } else if (stage !== "body") {
      const bootstrap = await vi.importActual<
        typeof import("openclaw/plugin-sdk/device-bootstrap")
      >("openclaw/plugin-sdk/device-bootstrap");
      issueDeviceBootstrapToken.mockImplementationOnce((params) =>
        withTempHome(async () => {
          entered.resolve();
          await resume.promise;
          try {
            return await bootstrap.issueDeviceBootstrapToken(params);
          } finally {
            persistedTokens = (await bootstrap.clearDeviceBootstrapTokens()).removed;
          }
        }),
      );
    }
    const req = createPendingAuthRequest("203.0.113.60");
    const pending = callRouteRequest(route, req);
    try {
      if (stage === "body") {
        currentConfig = config(["999999"]);
      }
      req.push(Buffer.from(authBody({ nonce: `revoked-${stage}` })));
      req.complete = true;
      req.push(null);
      if (stage !== "body") {
        expect(
          await Promise.race([
            entered.promise.then(() => "entered"),
            pending.then(() => "finished"),
          ]),
        ).toBe("entered");
        if (stage === "bot token") {
          currentConfig = {
            ...config(),
            channels: { telegram: { botToken: "replacement", allowFrom: ["123456"] } },
          };
        } else if (stage !== "unchanged") {
          currentConfig = config(["999999"]);
        }
      }
      resume.resolve();
      const res = await pending;
      expect(res.statusCode).toBe(stage === "unchanged" ? 200 : 403);
      if (stage === "unchanged") {
        expect(JSON.parse(res.body).bootstrapToken).toBeTypeOf("string");
        expect(persistedTokens).toBe(1);
      } else {
        expect(res.body).toBe("Restricted to the bot owner.");
        if (stage === "credential") {
          expect(persistedTokens).toBe(0);
        } else if (stage !== "credential response") {
          expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
        }
      }
    } finally {
      resume.resolve();
      req.destroy();
      await pending;
    }
  });

  it("rejects replayed init-data without minting again", async () => {
    const route = createRoute(config());
    const initData = signedInitData("123456", "replay");
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });
    await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData, launchTicket }),
      ip: "203.0.113.20",
    });
    const replay = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData, launchTicket }),
      ip: "203.0.113.20",
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.body).toBe("This link expired. Run /controlui again in your bot chat.");
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("reserves validated init-data before minting", async () => {
    const route = createRoute(config());
    const initData = signedInitData("123456", "concurrent");
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });

    const responses = await Promise.all([
      callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData, launchTicket }),
        ip: "203.0.113.21",
      }),
      callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData, launchTicket }),
        ip: "203.0.113.22",
      }),
    ]);

    expect(responses.map((res) => res.statusCode).toSorted((a, b) => a - b)).toEqual([200, 401]);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("rejects non-owner Mini App auth requests", async () => {
    const route = createRoute(config(["999999"]));
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({
        initData: signedInitData("123456", "non-owner"),
        launchTicket,
      }),
      ip: "203.0.113.30",
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Restricted to the bot owner.");
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(
      launchTickets.consume({ ticket: launchTicket, accountId: "default", userId: "123456" }),
    ).toBe(true);
  });

  it("rejects owner init-data without an issued launch ticket", async () => {
    const route = createRoute(config());
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({
        initData: signedInitData("123456", "missing-ticket"),
        launchTicket: "not-issued",
      }),
      ip: "203.0.113.31",
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("This link expired. Run /controlui again in your bot chat.");
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("does not consume a launch ticket when URL resolution fails", async () => {
    resolveTelegramMiniAppUrls.mockRejectedValueOnce(new Error("not published"));
    const route = createRoute(config());
    const initData = signedInitData("123456", "url-retry");
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });
    const request = {
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData, launchTicket }),
      ip: "203.0.113.32",
    };

    const unavailable = await callRoute(request);
    const retry = await callRoute(request);

    expect(unavailable.statusCode).toBe(503);
    expect(retry.statusCode).toBe(200);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("rate-limits repeated auth requests by IP", async () => {
    const route = createRoute(config());
    let last: MockResponse | null = null;
    for (let i = 0; i < 11; i += 1) {
      last = await callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: authBody({ nonce: `rate-${i}` }),
        ip: "203.0.113.40",
      });
    }

    expect(last?.statusCode).toBe(429);
    expect(last?.body).toBe("Too many requests");
  });

  it("keeps malformed JSON on the expired-link response", async () => {
    const route = createRoute(config());
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: "{",
      ip: "203.0.113.49",
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("This link expired. Run /controlui again in your bot chat.");
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it.each(["content-length", "chunked"])(
    "flushes HTTP 413 before closing an oversized %s auth request",
    async (framing) => {
      const route = createRoute(config());
      const handled: Promise<unknown>[] = [];
      let request: IncomingMessage | undefined;
      const server = createServer((req, res) => {
        request = req;
        handled.push(Promise.resolve(route.handler(req, res)));
      });
      let socket: Socket | undefined;
      try {
        const port = await listen(server);
        socket = connect({ host: "127.0.0.1", port });
        await new Promise<void>((resolve) => {
          socket?.once("connect", resolve);
        });

        socket.write(
          [
            "POST /__openclaw_tg_miniapp/auth HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            framing === "content-length"
              ? `Content-Length: ${AUTH_BODY_MAX_BYTES + 1}`
              : "Transfer-Encoding: chunked",
            "Connection: keep-alive",
            "",
            framing === "content-length"
              ? "{"
              : `${(AUTH_BODY_MAX_BYTES + 1).toString(16)}\r\n${"x".repeat(AUTH_BODY_MAX_BYTES + 1)}\r\n0\r\n\r\n`,
          ].join("\r\n"),
        );

        const response = await readSocketResponse(socket);
        const [, body = ""] = response.split("\r\n\r\n", 2);

        expect(response).toContain("HTTP/1.1 413");
        expect(response).toContain("Connection: close");
        expect(body).toBe("Payload too large");
        expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
        await Promise.all(handled);
        expect(request?.socket.destroyed).toBe(true);
        if (!request) {
          throw new Error("expected auth request");
        }
        expectBodyReadListenersCleaned(request);
      } finally {
        socket?.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("settles an early client close without leaking request-body listeners", async () => {
    const route = createRoute(config());
    const req = createPendingAuthRequest("203.0.113.51");
    const responsePromise = callRouteRequest(route, req);

    req.emit("close");
    const res = await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Connection closed");
    expectBodyReadListenersCleaned(req);
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("flushes a real HTTP 408 response before closing a stalled auth request", async () => {
    vi.useFakeTimers();
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const route = createRoute(config());
    const handled: Promise<unknown>[] = [];
    let request: IncomingMessage | undefined;
    const server = createServer((req, res) => {
      request = req;
      handled.push(Promise.resolve(route.handler(req, res)));
      markRequestStarted?.();
    });
    let socket: Socket | undefined;
    try {
      const port = await listen(server);
      socket = connect({ host: "127.0.0.1", port });
      await new Promise<void>((resolve) => {
        socket?.once("connect", resolve);
      });

      socket.write(
        [
          "POST /__openclaw_tg_miniapp/auth HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 64",
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"),
      );

      await requestStarted;
      const responsePromise = readSocketResponse(socket);
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      const [, body = ""] = response.split("\r\n\r\n", 2);

      expect(response).toContain("HTTP/1.1 408");
      expect(response).toContain("Connection: close");
      expect(body).toBe("Request body timeout");
      expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
      await Promise.all(handled);
      expect(request?.socket.destroyed).toBe(true);
      if (!request) {
        throw new Error("expected auth request");
      }
      expectBodyReadListenersCleaned(request);
    } finally {
      vi.useRealTimers();
      socket?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
