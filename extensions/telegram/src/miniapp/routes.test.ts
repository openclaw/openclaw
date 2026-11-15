import crypto from "node:crypto";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createMockIncomingRequest,
  postRawWebhook,
  withServer,
  withTempHome,
} from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
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
const { publishedUrls, resolveTelegramMiniAppUrls } = vi.hoisted(() => {
  const urls = {
    pageUrl: "https://gateway.example/__openclaw_tg_miniapp/",
    controlUiUrl: "https://gateway.example/openclaw",
    gatewayUrl: "wss://gateway.example/openclaw",
  };
  return {
    publishedUrls: urls,
    resolveTelegramMiniAppUrls: vi.fn<typeof import("./url.js").resolveTelegramMiniAppUrls>(),
  };
});

vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  issueDeviceBootstrapToken,
}));

vi.mock("./url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./url.js")>();
  resolveTelegramMiniAppUrls.mockImplementation(actual.resolveTelegramMiniAppUrls);
  return { ...actual, resolveTelegramMiniAppUrls };
});

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

beforeEach(() => {
  launchTickets = createTelegramMiniAppLaunchTickets();
  issueDeviceBootstrapToken.mockClear();
  resolveTelegramMiniAppUrls.mockClear();
});

class MockResponse {
  statusCode = 200;
  body = "";
  writeHead(statusCode: number) {
    this.statusCode = statusCode;
  }
  end(body?: string) {
    this.body = body ?? "";
  }
}

function createRoute(cfg = config(), currentConfig = () => cfg) {
  return registerMiniApp(cfg, currentConfig, true).route;
}

async function callRouteRequest(route: OpenClawPluginHttpRouteParams, req: IncomingMessage) {
  const res = new MockResponse() as ServerResponse & MockResponse;
  await route.handler(req, res);
  return res;
}

function callAuth(
  route: OpenClawPluginHttpRouteParams,
  body: string | Record<string, unknown>,
  ip = "203.0.113.10",
  contentType = "application/json",
) {
  const req = createMockIncomingRequest([typeof body === "string" ? body : JSON.stringify(body)]);
  return callRouteRequest(route, prepareAuthRequest(req, ip, contentType));
}

function registerMiniApp(cfg: OpenClawConfig, current = () => cfg, routesOnly = false) {
  const commands: OpenClawPluginCommandDefinition[] = [];
  const routes: OpenClawPluginHttpRouteParams[] = [];
  const api = createTestPluginApi({
    config: cfg,
    registerCommand: (command) => commands.push(command),
    registerHttpRoute: (route) => routes.push(route),
  });
  api.runtime.config = { current, mutateConfigFile: vi.fn(), replaceConfigFile: vi.fn() };
  if (routesOnly) {
    registerTelegramMiniAppRoutes(api, launchTickets);
  } else {
    registerTelegramMiniApp(api);
  }
  const route = routes.find((entry) => entry.path === "/__openclaw_tg_miniapp/");
  if (!route) {
    throw new Error("expected registered Mini App route");
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
  return {
    route,
    command: (overrides: Partial<PluginCommandContext> = {}) => {
      const command = commands.find((entry) => entry.name === "controlui");
      if (!command) {
        throw new Error("expected registered Mini App command");
      }
      return command.handler({ ...context, ...overrides });
    },
  };
}

function createPendingAuthRequest(ip: string): IncomingMessage {
  return prepareAuthRequest(new IncomingMessage(new Socket()), ip);
}

it("settles an early client close without leaking request-body listeners", async () => {
  const req = createPendingAuthRequest("203.0.113.51");
  const responsePromise = callRouteRequest(createRoute(), req);
  req.emit("close");
  const res = await responsePromise;
  expect(res.statusCode).toBe(400);
  expect(res.body).toBe("Connection closed");
  for (const event of ["data", "end", "error", "close"] as const) {
    expect(req.listenerCount(event), event).toBe(0);
  }
  expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
});

function prepareAuthRequest(req: IncomingMessage, ip: string, contentType = "application/json") {
  req.method = "POST";
  req.url = "/__openclaw_tg_miniapp/auth";
  req.headers = { "content-type": contentType };
  Object.defineProperty(req.socket, "remoteAddress", { value: ip });
  return req;
}

it.each([
  ["content-length", "{", 413, "Payload too large"],
  ["chunked", "x".repeat(AUTH_BODY_MAX_BYTES + 1), 413, "Payload too large"],
  ["stalled", "{", 408, "Request body timeout"],
] as const)(
  "flushes the rejection before closing %s auth requests",
  async (framing, body, statusCode, expectedBody) => {
    if (framing === "stalled") {
      vi.useFakeTimers();
    }
    const route = createRoute();
    const started = Promise.withResolvers<void>();
    const handled = Promise.withResolvers<IncomingMessage>();
    await withServer(
      (req, res) => {
        handled.resolve(Promise.resolve(route.handler(req, res)).then(() => req));
        started.resolve();
      },
      async (url) => {
        try {
          const responsePromise = postRawWebhook({
            url: `${url}/__openclaw_tg_miniapp/auth`,
            body,
            headers: { "Content-Type": "application/json", Connection: "keep-alive" },
            chunkedEncoding: framing === "chunked",
            contentLength: framing === "stalled" ? 64 : AUTH_BODY_MAX_BYTES + 1,
            idleTimeoutMs: 10_000,
          });
          await started.promise;
          if (framing === "stalled") {
            await vi.advanceTimersByTimeAsync(5_000);
          }
          expect(await responsePromise).toMatchObject({
            statusLine: expect.stringContaining(`HTTP/1.1 ${statusCode}`),
            headers: { connection: "close" },
            body: expectedBody,
            closedByServer: true,
          });
          expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
          const request = await handled.promise;
          expect(request.socket.destroyed).toBe(true);
          for (const event of ["data", "end", "error", "close"] as const) {
            expect(request.listenerCount(event), event).toBe(0);
          }
        } finally {
          if (framing === "stalled") {
            vi.useRealTimers();
          }
        }
      },
    );
  },
);

function config(
  allowFrom: string[] = ["123456"],
  botToken = BOT_TOKEN,
  accounts?: Record<string, { allowFrom: string[] }>,
): OpenClawConfig {
  return {
    channels: { telegram: { botToken, allowFrom, accounts } },
    gateway: {
      publicOrigin: "https://gateway.example",
      controlUi: { basePath: "/openclaw" },
    },
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

function authBody(nonce: string, accountId?: string, launchTicket?: string) {
  return {
    initData: signedInitData("123456", nonce),
    accountId,
    launchTicket:
      launchTicket ?? launchTickets.issue({ accountId: accountId ?? "default", userId: "123456" }),
  };
}

it("serves the page without resolving published URLs", async () => {
  const req = createMockIncomingRequest([]);
  req.method = "GET";
  req.url = "/__openclaw_tg_miniapp/?accountId=ops";
  const res = await callRouteRequest(createRoute({}), req);

  expect(res.statusCode).toBe(200);
  expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
});

it("recovers wildcard-only Control UI access with an explicit owner ID and rejects group launches", async () => {
  const allowFrom = ["accessGroup:operators"];
  const cfg = config(["999999"], BOT_TOKEN, { ops: { allowFrom } });
  cfg.accessGroups = {
    operators: { type: "message.senders", members: { telegram: ["*"] } },
  };
  const { command, route } = registerMiniApp(cfg);

  const groupReply = await command({
    from: "telegram:group:-100",
    sessionKey: "telegram:group:-100",
    senderIsOwner: true,
  });
  expect(groupReply.text).toContain("DM");
  expect(groupReply.presentation).toBeUndefined();
  expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
  expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();

  const deniedReply = await command();
  expect(deniedReply.text).toContain("numeric Telegram user ID (123456)");
  expect(deniedReply.presentation).toBeUndefined();
  expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
  expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();

  allowFrom.push("123456");
  const reply = await command();
  const buttons = reply.presentation?.blocks.find((block) => block.type === "buttons");
  const webAppUrl = buttons?.buttons[0]?.webApp?.url;
  if (!webAppUrl) {
    throw new Error("expected an owner DM Web App launch URL");
  }
  const launchUrl = new URL(webAppUrl);
  const launchTicket = new URLSearchParams(launchUrl.hash.slice(1)).get("launchTicket");
  const res = await callAuth(
    route,
    {
      initData: signedInitData("123456", "registered-command"),
      accountId: launchUrl.searchParams.get("accountId"),
      launchTicket,
    },
    "203.0.113.10",
    "application/json; charset=utf-8",
  );

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({
    bootstrapToken: "issued",
    controlUiUrl: "https://gateway.example/openclaw",
    gatewayUrl: "wss://gateway.example/openclaw",
  });
  expect(issueDeviceBootstrapToken.mock.calls[0]?.[0]?.profile).toEqual({
    roles: ["operator"],
    scopes: [
      "operator.approvals",
      "operator.questions",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ],
    purpose: "control-ui",
  });
});

it.each([
  { source: "command", channel: "*", members: ["*"], allowed: false },
  { source: "command", channel: "*", members: ["telegram:123456"], allowed: true },
  { source: "account", channel: "telegram", members: ["@owner", "999999"], allowed: false },
  { source: "account", channel: "telegram", members: ["*", "tg:123456"], allowed: true },
])(
  "requires explicit group ownership: $source / $channel / $members",
  async ({ source, channel, members, allowed }) => {
    const cfg = config(
      [],
      BOT_TOKEN,
      source === "account" ? { ops: { allowFrom: ["accessGroup:operators"] } } : undefined,
    );
    cfg.accessGroups = {
      operators: { type: "message.senders", members: { [channel]: members } },
    };
    if (source === "command") {
      cfg.commands = { ownerAllowFrom: ["accessGroup:operators"] };
    }
    const { command } = registerMiniApp(cfg);
    const reply = await command({ senderIsOwner: true });
    if (allowed) {
      expect(reply.presentation?.blocks).toEqual([expect.objectContaining({ type: "buttons" })]);
    } else {
      expect(reply.text).toContain("Restricted to the bot owner.");
      expect(reply.presentation).toBeUndefined();
    }

    // A previously issued ticket must not bypass the auth route's owner check.
    const body = authBody("group-owner", "ops");
    const res = await callAuth(createRoute(cfg), body, `203.0.113.${100 + signedNonceSequence}`);
    expect(res.statusCode).toBe(allowed ? 200 : 403);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(res.body).toBe("Restricted to the bot owner.");
      expect(
        launchTickets.consume({ ticket: body.launchTicket, accountId: "ops", userId: "123456" }),
      ).toBe(true);
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
      return publishedUrls;
    });
  } else if (stage === "credential response") {
    issueDeviceBootstrapToken.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { token: "issued", expiresAtMs: Date.now() + 600_000 };
    });
  } else if (stage !== "body") {
    const bootstrap = await vi.importActual<typeof import("openclaw/plugin-sdk/device-bootstrap")>(
      "openclaw/plugin-sdk/device-bootstrap",
    );
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
    req.push(Buffer.from(JSON.stringify(authBody(`revoked-${stage}`))));
    req.complete = true;
    req.push(null);
    if (stage !== "body") {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), pending.then(() => "finished")]),
      ).toBe("entered");
      if (stage === "bot token") {
        currentConfig = config(["123456"], "replacement");
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

it.each(["concurrent", "url-retry"] as const)("mints only once: %s", async (mode) => {
  const route = createRoute();
  const body = authBody(mode);
  if (mode === "url-retry") {
    resolveTelegramMiniAppUrls.mockRejectedValueOnce(new Error("not published"));
  }
  const first = callAuth(route, body, "203.0.113.20");
  if (mode !== "concurrent") {
    await first;
  }
  const responses = await Promise.all([first, callAuth(route, body, "203.0.113.21")]);
  const expected = mode === "url-retry" ? [503, 200] : [200, 401];
  const codes = responses.map((res) => res.statusCode);
  expect(mode === "concurrent" ? codes.toSorted((a, b) => a - b) : codes).toEqual(expected);
  expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
});

it("rejects owner init-data without an issued launch ticket", async () => {
  const res = await callAuth(
    createRoute(),
    authBody("missing-ticket", "default", "not-issued"),
    "203.0.113.31",
  );

  expect(res.statusCode).toBe(401);
  expect(res.body).toBe("This link expired. Run /controlui again in your bot chat.");
  expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
});

it("rate-limits repeated auth requests by IP", async () => {
  const route = createRoute();
  let last: MockResponse | null = null;
  for (let i = 0; i < 11; i += 1) {
    last = await callAuth(route, authBody(`rate-${i}`), "203.0.113.40");
  }

  expect(last?.statusCode).toBe(429);
  expect(last?.body).toBe("Too many requests");
});
