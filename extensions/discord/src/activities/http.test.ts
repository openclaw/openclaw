import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as logging from "openclaw/plugin-sdk/logging-core";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { WEBHOOK_BODY_READ_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import { setDiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
  createRegisteredActivityFixture,
} from "./test-helpers.test-support.js";

const servers: Server[] = [];
const identity = { accountId: "default", channelId: "777", discordUserId: "42" };
const instance = "instance_id=instance-1";
const vendorRoute = "/vendor/embedded-app-sdk.mjs";
vi.mock("openclaw/plugin-sdk/ssrf-runtime", { spy: true });
vi.mock("openclaw/plugin-sdk/logging-core", { spy: true });
beforeEach(() => {
  vi.stubEnv("DISCORD_CLIENT_SECRET", "");
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  vi.mocked(fetchWithSsrFGuard).mockRestore();
  vi.mocked(logging.logError).mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDiscordActivitiesRuntime(undefined);
});

function storeFixture(runtime = createActivityTestRuntime()) {
  return {
    runtime,
    async widget(createdAt = 1, channelId = "777") {
      const id = await runtime.store.createWidget({
        html: "<script>document.body.dataset.ready='yes'</script>",
        title: "Activity status",
        accountId: "default",
        channelId,
        createdAt,
      });
      await runtime.store.markWidgetDelivered(
        id,
        String(1_000_000_000_000_000_000n + BigInt(createdAt)),
      );
      return id;
    },
    pending: (widgetId: string, createdAt = 3, accountId = "default") =>
      runtime.store.recordPendingLaunch({ ...identity, widgetId, createdAt, accountId }),
    consume: (accountId = "default") => runtime.store.consumePendingLaunch(accountId, "777", "42"),
  };
}

async function serve(
  fixture = createRegisteredActivityFixture(),
  guard?: typeof fetchWithSsrFGuard,
) {
  if (guard) {
    vi.mocked(fetchWithSsrFGuard).mockImplementation(guard);
  }
  const server = createServer((req, res) => {
    void Promise.resolve(fixture.route.handler(req, res)).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  servers.push(server);
  const base = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const get = (route: string, token?: string) =>
    fetch(
      `${base}/discord/activity${route}`,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
  return { ...storeFixture(fixture.runtime), base, get };
}

function guardedJsonFetch(params?: {
  userId?: string;
  channelId?: string;
  instanceUsers?: string[];
  onExchange?: (code: string | null) => Promise<number | void> | number | void;
}) {
  return vi.fn<typeof fetchWithSsrFGuard>(async ({ url, init }) => {
    const exchange = url.includes("/oauth2/token");
    const status = exchange
      ? await params?.onExchange?.(
          init?.body instanceof URLSearchParams ? init.body.get("code") : null,
        )
      : undefined;
    const body = exchange
      ? { access_token: "atoken" }
      : url.includes("/activity-instances/")
        ? {
            location: { channel_id: params?.channelId ?? "777" },
            users: params?.instanceUsers ?? ["42"],
          }
        : { id: params?.userId ?? "42" };
    return {
      response: Response.json(body, { status: status ?? 200 }),
      finalUrl: url,
      release: vi.fn(async () => undefined),
    };
  });
}

async function tokenServer(guard: typeof fetchWithSsrFGuard = guardedJsonFetch()) {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const cfg = createActivityTestConfig();
  cfg.gateway = { trustedProxies: ["127.0.0.1"] };
  return (await serve(createRegisteredActivityFixture(cfg), guard)).base;
}
function tokenSource(
  index: number,
  code = "ok",
  origin = "https://123456789012345678.discordsays.com",
) {
  return {
    body: JSON.stringify({ code }),
    headers: { Origin: origin, "X-Forwarded-For": `198.51.100.${index + 1}` },
  };
}
function requestToken(
  base: string,
  {
    body = JSON.stringify({ code: "oauth-code" }),
    headers,
  }: { body?: string; headers?: Record<string, string> } = {},
) {
  return fetch(`${base}/discord/activity/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}
async function requestTokens(
  base: string,
  count: number,
  params: (index: number) => Parameters<typeof requestToken>[1],
  status: number,
) {
  for (let index = 0; index < count; index++) {
    expect((await requestToken(base, params(index))).status).toBe(status);
  }
}
async function expectWidget(response: Response, id: string) {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ id });
}
async function widgetFixture(guard: typeof fetchWithSsrFGuard = guardedJsonFetch()) {
  const fixture = await serve(undefined, guard);
  const session = await fixture.runtime.store.createSession(identity);
  const request = (query = instance) => fixture.get(`/api/widget?${query}`, session);
  return {
    ...fixture,
    request,
    expectWidget: async (id: string, query?: string) => expectWidget(await request(query), id),
    customId: (id: string) =>
      request(`custom_id=${encodeURIComponent(buildDiscordActivityCustomId(id))}&${instance}`),
  };
}

describe("Discord Activity HTTP OAuth", () => {
  it.each([false, true])(
    "cancels rejected OAuth bodies before release; cancel fails=%s",
    async (cancelFails) => {
      const lifecycle: string[] = [];
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("rejected"));
          },
          cancel() {
            lifecycle.push("cancel");
            if (cancelFails) {
              throw new Error("cancel failed");
            }
          },
        }),
        { status: cancelFails ? 429 : 401 },
      );
      const base = await tokenServer(async () => ({
        response,
        finalUrl: "https://discord.com/api/oauth2/token",
        release: async () => {
          lifecycle.push("release");
        },
      }));
      const result = await requestToken(base);
      expect(result.status).toBe(401);
      await expect(result.json()).resolves.toEqual({ error: "invalid authorization code" });
      expect(lifecycle).toEqual(["cancel", "release"]);
    },
  );

  it("leaves the public prefix absent when the bot token is unresolved", async () => {
    const cfg = createActivityTestConfig();
    const f = await serve(
      createRegisteredActivityFixture({
        channels: {
          discord: {
            ...cfg.channels?.discord,
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      }),
    );
    const response = await f.get("/");
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not found");
  });

  it.each([
    // One write reproduces the response-flush race; an incomplete body exercises the deadline.
    [
      "HTTP/1.1 413 Payload Too Large",
      5_000,
      JSON.stringify({ code: "x".repeat(8 * 1024) }),
      undefined,
      "request body too large",
    ],
    ["HTTP/1.1 408 Request Timeout", 50, "{", 4 * 1024, "request body timeout"],
  ] as const)(
    "delivers %s and closes the connection",
    async (statusLine, timeout, body, contentLength, error) => {
      vi.spyOn(WEBHOOK_BODY_READ_DEFAULTS.preAuth, "timeoutMs", "get").mockReturnValue(timeout);
      const { base } = await serve();
      const result = await postRawWebhook({
        url: `${base}/discord/activity/api/token`,
        body,
        contentLength,
        headers: { "content-type": "application/json" },
      });
      expect(result).toMatchObject({ statusLine, closedByServer: true });
      expect(JSON.parse(result.body)).toEqual({ error });
    },
  );

  it("lets a channel member outside the agent allowlist open the widget", async () => {
    const f = await serve(undefined, guardedJsonFetch({ userId: "99", instanceUsers: ["99"] }));
    const id = await f.widget();
    const response = await requestToken(f.base);
    expect(response.status).toBe(200);
    const token = (await response.json()) as { session_token: string };
    await expectWidget(
      await f.get(`/api/widget?custom_id=${id}&${instance}`, token.session_token),
      id,
    );
  });

  it("limits token requests to ten per source IP per minute", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { base } = await serve();
    await requestTokens(base, 10, () => ({ body: "{}" }), 401);
    expect((await requestToken(base, { body: "{}" })).status).toBe(429);
  });

  it.each([
    ["unresolved", 503],
    ["malformed", 401],
    ["Discord-rejected", 401],
  ] as const)("does not charge %s requests to the global budget", async (kind, status) => {
    const base = await tokenServer(
      guardedJsonFetch({ onExchange: (code) => (code === "bogus" ? 400 : 200) }),
    );
    await requestTokens(
      base,
      61,
      (index) => ({
        ...tokenSource(
          index,
          "bogus",
          kind === "unresolved"
            ? `https://${100_000_000_000_000_000n + BigInt(index)}.discordsays.com`
            : undefined,
        ),
        ...(kind !== "Discord-rejected" ? { body: "{}" } : {}),
      }),
      status,
    );
    expect((await requestToken(base, tokenSource(249))).status).toBe(200);
  });

  it("reserves global capacity across IPs and keeps successful exchanges charged", async () => {
    const gate = createDeferred<void>();
    let calls = 0;
    const base = await tokenServer(
      guardedJsonFetch({
        onExchange: async () => {
          calls++;
          await gate.promise;
        },
      }),
    );
    const pending = Array.from({ length: 60 }, (_, index) =>
      requestToken(base, tokenSource(index)),
    );
    try {
      await vi.waitFor(() => expect(calls).toBe(60), { timeout: 5_000 });
      expect((await requestToken(base, tokenSource(249))).status).toBe(429);
    } finally {
      gate.resolve();
    }
    expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
    expect((await requestToken(base, tokenSource(249))).status).toBe(429);
  });
});

describe("Discord Activity widget routes", () => {
  it.each([undefined, "a".repeat(43)])("requires a valid bearer session: %s", async (token) => {
    const f = await serve();
    expect((await f.get("/api/widget?instance_id=abc", token)).status).toBe(401);
  });

  it("resolves a custom ID and serves its document only once with a sandbox CSP", async () => {
    const f = await widgetFixture();
    const id = await f.widget();
    await f.widget(2);
    await f.pending(id);
    const direct = await f.customId(id);
    expect(direct.status).toBe(200);
    const metadata = (await direct.json()) as { id: string; docUrl: string };
    expect(metadata.id).toBe(id);
    await expect(f.consume()).resolves.toBeUndefined();
    const url = new URL(metadata.docUrl, f.base);
    const document = await fetch(url);
    expect(document.status).toBe(200);
    const csp = document.headers.get("content-security-policy");
    for (const directive of [
      "sandbox allow-scripts",
      "connect-src 'none'",
      "https://cdn.jsdelivr.net",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(await document.text()).toContain("document.body.dataset.ready");
    const replay = await fetch(url);
    expect(replay.status).toBe(404);
    expect(replay.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(replay.headers.get("content-security-policy")).toContain("connect-src 'none'");
  });

  it.each(["explicit", "ambiguous", "single", "repeated", "offline"])(
    "resolves pending launches: %s",
    async (mode) => {
      const f = await widgetFixture();
      const first = await f.widget();
      const newest = await f.widget(2);
      if (mode === "offline") {
        vi.mocked(logging.logError).mockImplementation(() => {});
        vi.spyOn(f.runtime.store, "consumePendingLaunch").mockRejectedValue(
          new Error("store offline"),
        );
      } else if (mode === "ambiguous") {
        await Promise.all([f.pending(first, 3), f.pending(newest, 4)]);
      } else {
        await f.pending(mode === "explicit" ? newest : first);
        if (mode === "repeated") {
          await f.pending(first, 4);
        }
      }
      const query =
        mode === "explicit"
          ? `custom_id=${first}&${instance}`
          : `custom_id=ocactivity1_mangled&${instance}`;
      const expected = mode === "ambiguous" || mode === "offline" ? newest : first;
      await f.expectWidget(expected, query);
      if (mode === "explicit") {
        await expect(f.consume()).resolves.toMatchObject({ widgetId: newest });
      } else if (mode !== "offline") {
        await expect(f.consume()).resolves.toBeUndefined();
      }
      // Repeating the query proves consumption, and error logging remains once-only.
      await f.expectWidget(
        newest,
        mode === "offline" ? `custom_id=missing&${instance}` : undefined,
      );
      if (mode === "offline") {
        expect(logging.logError).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps pending launches isolated by Discord account", async () => {
    const f = storeFixture();
    await f.pending("AAAAAAAAAAAAAAAAAAAAAA", 1, "account-b");
    await expect(f.consume("account-a")).resolves.toBeUndefined();
    await expect(f.consume("account-b")).resolves.toMatchObject({
      widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("ignores a forged channel ID when no Activity instance is supplied", async () => {
    // No guard mock: this path must not need the Discord Instance API.
    const f = await serve();
    const session = await f.runtime.store.createSession(identity);
    await f.widget();
    expect((await f.get("/api/widget?channel_id=777", session)).status).toBe(404);
  });

  it("uses the authenticated Activity Instance API channel instead of a forged channel", async () => {
    const guard = guardedJsonFetch({ channelId: "777" });
    const f = await widgetFixture(guard);
    await f.widget(1, "888");
    const newest = await f.widget(2);
    await f.expectWidget(newest, `custom_id=missing&${instance}&channel_id=888`);
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://discord.com/api/v10/applications/123456789012345678/activity-instances/instance-1",
        init: expect.objectContaining({ headers: { Authorization: "Bot testtok" } }),
      }),
    );
  });

  it.each([
    { name: "outside the instance channel", channel: "888", users: ["42"] },
    { name: "without the session user in the instance", channel: "777", users: ["99"] },
  ])("rejects a custom ID $name", async ({ channel, users }) => {
    const f = await widgetFixture(guardedJsonFetch({ instanceUsers: users }));
    const id = await f.widget(1, channel);
    expect((await f.request(`custom_id=${id}&${instance}`)).status).toBe(404);
  });
});

describe("Discord Activity shell assets", () => {
  it("retries a failed SDK read and serves the generated asset from a dist plugin root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-activity-dist-"));
    const asset = path.join(root, "dist/extensions/discord/assets/embedded-app-sdk.mjs");
    try {
      await fs.mkdir(path.dirname(asset), { recursive: true });
      await fs.writeFile(asset, "export class DiscordSDK {}\n");
      const f = await serve(createRegisteredActivityFixture(undefined, asset));
      vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("transient read failure"));
      expect((await f.get(vendorRoute)).status).toBe(404);
      const vendor = await f.get(vendorRoute);
      expect(vendor.status).toBe(200);
      await expect(vendor.text()).resolves.toContain("DiscordSDK");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves the shell and module", async () => {
    const f = await serve();
    const shell = await f.get("/");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<script type="module" src="./shell.js">');
    const script = await (await f.get("/shell.js")).text();
    expect(script).toContain('from "./vendor/embedded-app-sdk.mjs"');
    expect(script).toContain("instance_id: sdk.instanceId");
    expect(script).not.toContain("channel_id: sdk.channelId");
    expect(script).toContain('frame.setAttribute("sandbox", "allow-scripts")');
  });
});
