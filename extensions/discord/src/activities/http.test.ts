import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as logging from "openclaw/plugin-sdk/logging-core";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { WEBHOOK_BODY_READ_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import { DiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
  createRegisteredActivityFixture,
} from "./test-helpers.test-support.js";

const servers: Server[] = [];

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

async function startServer(
  fixture: ReturnType<typeof createRegisteredActivityFixture>,
  options: { vendorAssetPath?: string; fetchGuard?: typeof fetchWithSsrFGuard } = {},
): Promise<string> {
  if (options.fetchGuard) {
    vi.mocked(fetchWithSsrFGuard).mockImplementation(options.fetchGuard);
  }
  const { route } = fixture;
  const server = createServer((req, res) => {
    void Promise.resolve(route.handler(req, res)).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function guardedJsonFetch(params?: {
  userId?: string;
  channelId?: string;
  instanceUsers?: string[];
  onExchange?: (code: string | null) => Promise<number | void> | number | void;
}) {
  return vi.fn<typeof fetchWithSsrFGuard>(async ({ url, init }) => {
    const wantsExchange = url.includes("/oauth2/token");
    const wantsInstance = url.includes("/activity-instances/");
    const exchangeStatus = wantsExchange
      ? await params?.onExchange?.(
          init?.body instanceof URLSearchParams ? init.body.get("code") : null,
        )
      : undefined;
    const body = wantsExchange
      ? { access_token: "atoken" }
      : wantsInstance
        ? {
            location: { channel_id: params?.channelId ?? "777" },
            users: params?.instanceUsers ?? ["42"],
          }
        : { id: params?.userId ?? "42" };
    return {
      response: Response.json(body, { status: exchangeStatus ?? 200 }),
      finalUrl: url,
      release: vi.fn(async () => undefined),
    };
  });
}

async function createWidget(
  runtime: DiscordActivitiesRuntime,
  params?: { createdAt?: number; channelId?: string; accountId?: string },
) {
  const createdAt = params?.createdAt ?? 1;
  const widgetId = await runtime.store.createWidget({
    html: "<!doctype html><html><body><script>document.body.dataset.ready='yes'</script></body></html>",
    title: "Activity status",
    channelId: params?.channelId ?? "777",
    accountId: params?.accountId ?? "default",
    createdAt,
  });
  await runtime.store.markWidgetDelivered(
    widgetId,
    String(1_000_000_000_000_000_000n + BigInt(createdAt)),
  );
  return widgetId;
}

function startTokenServer(fetchGuard = guardedJsonFetch()) {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const cfg = createActivityTestConfig();
  cfg.gateway = { trustedProxies: ["127.0.0.1"] };
  return startServer(createRegisteredActivityFixture(cfg), { fetchGuard });
}

const activityOrigin = "https://123456789012345678.discordsays.com";

function tokenSource(index: number, code = "ok") {
  return { code, origin: activityOrigin, forwardedFor: `198.51.100.${index + 1}` };
}

function requestToken(
  base: string,
  params: {
    body?: string;
    code?: string;
    forwardedFor?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  return fetch(`${base}/discord/activity/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(params.origin ? { Origin: params.origin } : {}),
      ...(params.forwardedFor ? { "X-Forwarded-For": params.forwardedFor } : {}),
    },
    body: params.body ?? JSON.stringify({ code: params.code ?? "oauth-code" }),
  });
}

async function requestTokens(
  base: string,
  count: number,
  params: (index: number) => Parameters<typeof requestToken>[1],
  status: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    expect((await requestToken(base, params(index))).status).toBe(status);
  }
}

async function expectWidget(response: Response, id: string) {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ id });
}

function requestWidget(base: string, query: string, sessionToken?: string): Promise<Response> {
  return fetch(
    `${base}/discord/activity/api/widget?${query}`,
    sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : undefined,
  );
}

function recordPendingLaunch(
  runtime: DiscordActivitiesRuntime,
  widgetId: string,
  createdAt: number,
  accountId = "default",
) {
  return runtime.store.recordPendingLaunch({
    accountId,
    channelId: "777",
    discordUserId: "42",
    widgetId,
    createdAt,
  });
}

function consumePendingLaunch(runtime: DiscordActivitiesRuntime, accountId = "default") {
  return runtime.store.consumePendingLaunch(accountId, "777", "42");
}

async function createWidgetFixture(
  options: Parameters<typeof startServer>[1] = { fetchGuard: guardedJsonFetch() },
) {
  const fixture = createRegisteredActivityFixture(undefined, options.vendorAssetPath);
  const { runtime } = fixture;
  const session = await runtime.store.createSession({ discordUserId: "42", accountId: "default" });
  const base = await startServer(fixture, options);
  const request = (query: string) => requestWidget(base, query, session);
  return {
    base,
    runtime,
    widget: (params?: Parameters<typeof createWidget>[1]) => createWidget(runtime, params),
    request,
    customId: (id: string) =>
      request(
        `custom_id=${encodeURIComponent(buildDiscordActivityCustomId(id))}&instance_id=instance-1`,
      ),
    recordPending: (widgetId: string, createdAt = 3) =>
      recordPendingLaunch(runtime, widgetId, createdAt),
    consumePending: () => consumePendingLaunch(runtime),
  };
}

describe("Discord Activity HTTP OAuth", () => {
  it.each([false, true])(
    "cancels rejected OAuth bodies before release when cancellation fails=%s",
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
      const guard = vi.fn<typeof fetchWithSsrFGuard>(async () => ({
        response,
        finalUrl: "https://discord.com/api/oauth2/token",
        release: async () => {
          lifecycle.push("release");
        },
      }));
      const base = await startTokenServer(guard);
      const result = await requestToken(base);
      expect(result.status).toBe(401);
      await expect(result.json()).resolves.toEqual({ error: "invalid authorization code" });
      expect(lifecycle).toEqual(["cancel", "release"]);
    },
  );

  it("leaves the public prefix externally absent when the bot token is unresolved", async () => {
    const cfg = createActivityTestConfig();
    const config = {
      ...cfg,
      channels: {
        discord: {
          ...cfg.channels?.discord,
          token: { source: "env" as const, provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    };
    const base = await startServer(createRegisteredActivityFixture(config));
    const response = await fetch(`${base}/discord/activity/`);
    await expect(response.text()).resolves.toBe("not found");
    expect(response.status).toBe(404);
  });

  it.each([
    // Send the oversized body in one write; rejection used to race the response flush.
    [
      "HTTP/1.1 413 Payload Too Large",
      5_000,
      JSON.stringify({ code: "x".repeat(8 * 1024) }),
      undefined,
      "request body too large",
    ],
    // Promise more than is sent so the read deadline fires while the request is open.
    ["HTTP/1.1 408 Request Timeout", 50, "{", 4 * 1024, "request body timeout"],
  ] as const)(
    "delivers %s and closes the connection",
    async (statusLine, bodyTimeoutMs, body, contentLength, error) => {
      vi.spyOn(WEBHOOK_BODY_READ_DEFAULTS.preAuth, "timeoutMs", "get").mockReturnValue(
        bodyTimeoutMs,
      );
      const base = await startServer(createRegisteredActivityFixture());
      const result = await postRawWebhook({
        url: `${base}/discord/activity/api/token`,
        body,
        contentLength,
        headers: { "content-type": "application/json" },
      });
      expect(result.statusLine).toBe(statusLine);
      expect(JSON.parse(result.body)).toEqual({ error });
      expect(result.closedByServer).toBe(true);
    },
  );

  it("lets a channel member outside the agent allowlist open the widget", async () => {
    const fixture = createRegisteredActivityFixture();
    const { runtime } = fixture;
    const widgetId = await createWidget(runtime);
    const base = await startServer(fixture, {
      fetchGuard: guardedJsonFetch({ userId: "99", instanceUsers: ["99"] }),
    });
    const response = await requestToken(base);
    expect(response.status).toBe(200);
    const token = (await response.json()) as { session_token: string };

    await expectWidget(
      await requestWidget(
        base,
        `custom_id=${widgetId}&instance_id=instance-1`,
        token.session_token,
      ),
      widgetId,
    );
  });

  it("limits token requests to ten per source IP per minute", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const base = await startServer(createRegisteredActivityFixture());
    await requestTokens(base, 10, () => ({ body: "{}" }), 401);
    expect((await requestToken(base, { body: "{}" })).status).toBe(429);
  });

  it.each([
    { kind: "unresolved", status: 503 },
    { kind: "malformed", status: 401 },
    { kind: "Discord-rejected", status: 401 },
  ])("does not charge $kind requests to the global budget", async ({ kind, status }) => {
    const base = await startTokenServer(
      guardedJsonFetch({ onExchange: (code) => (code === "bogus" ? 400 : 200) }),
    );
    await requestTokens(
      base,
      61,
      (index) => ({
        ...tokenSource(index, "bogus"),
        ...(kind !== "Discord-rejected" ? { body: "{}" } : {}),
        ...(kind === "unresolved"
          ? {
              origin: `https://${100_000_000_000_000_000n + BigInt(index)}.discordsays.com`,
            }
          : {}),
      }),
      status,
    );
    expect((await requestToken(base, tokenSource(249))).status).toBe(200);
  });

  it("limits valid token exchanges globally across rotating source IPs", async () => {
    const base = await startTokenServer();
    await requestTokens(base, 60, tokenSource, 200);
    expect((await requestToken(base, tokenSource(249))).status).toBe(429);
  });

  it("reserves global capacity before concurrent exchanges complete", async () => {
    const exchangeGate = createDeferred<void>();
    let exchangeCalls = 0;
    const guard = guardedJsonFetch({
      onExchange: async () => {
        exchangeCalls += 1;
        await exchangeGate.promise;
      },
    });
    const base = await startTokenServer(guard);
    const pending = Array.from({ length: 60 }, (_, index) =>
      requestToken(base, tokenSource(index)),
    );
    try {
      await vi.waitFor(() => expect(exchangeCalls).toBe(60), { timeout: 5_000 });
      expect((await requestToken(base, tokenSource(249))).status).toBe(429);
    } finally {
      exchangeGate.resolve();
    }
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });
});

describe("Discord Activity widget routes", () => {
  it("requires a valid bearer session", async () => {
    const base = await startServer(createRegisteredActivityFixture());
    expect((await requestWidget(base, "instance_id=abc")).status).toBe(401);
    expect((await requestWidget(base, "instance_id=abc", "a".repeat(43))).status).toBe(401);
  });

  it("resolves a custom ID in the validated instance channel and consumes its doc token", async () => {
    const fixture = await createWidgetFixture();
    const firstId = await fixture.widget({ createdAt: 1 });
    await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(firstId);

    const direct = await fixture.customId(firstId);
    expect(direct.status).toBe(200);
    const metadata = (await direct.json()) as { id: string; docUrl: string };
    expect(metadata.id).toBe(firstId);
    await expect(fixture.consumePending()).resolves.toBeUndefined();
    const documentUrl = new URL(metadata.docUrl, fixture.base);
    const firstDocument = await fetch(documentUrl);
    expect(firstDocument.status).toBe(200);
    const firstCsp = firstDocument.headers.get("content-security-policy");
    expect(firstCsp).toContain("sandbox allow-scripts");
    expect(firstCsp).toContain("connect-src 'none'");
    expect(firstCsp).toContain("https://cdn.jsdelivr.net");
    expect(firstCsp).toContain("https://fonts.googleapis.com");
    expect(firstCsp).toContain("https://fonts.gstatic.com");
    expect(await firstDocument.text()).toContain("document.body.dataset.ready");
    const secondDocument = await fetch(documentUrl);
    expect(secondDocument.status).toBe(404);
    const secondCsp = secondDocument.headers.get("content-security-policy");
    expect(secondCsp).toContain("sandbox allow-scripts");
    expect(secondCsp).toContain("connect-src 'none'");
  });

  it("keeps a different-widget pending launch when a custom ID resolves", async () => {
    const fixture = await createWidgetFixture();
    const requestedId = await fixture.widget({ createdAt: 1 });
    const pendingId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(pendingId);

    await expectWidget(await fixture.customId(requestedId), requestedId);
    await expect(fixture.consumePending()).resolves.toMatchObject({ widgetId: pendingId });
  });

  it("falls through to the newest widget when overlapping launches target different widgets", async () => {
    const fixture = await createWidgetFixture();
    const firstId = await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    await Promise.all([fixture.recordPending(firstId, 3), fixture.recordPending(newestId, 4)]);

    await expectWidget(await fixture.request("instance_id=instance-1"), newestId);
    await expect(fixture.consumePending()).resolves.toBeUndefined();
  });

  it("keeps a pending launch when the same widget is clicked twice", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime, { createdAt: 1 });
    await recordPendingLaunch(runtime, widgetId, 2);
    await recordPendingLaunch(runtime, widgetId, 3);

    await expect(consumePendingLaunch(runtime)).resolves.toMatchObject({ widgetId });
  });

  it("consumes a pending launch after one widget resolution", async () => {
    const fixture = await createWidgetFixture();
    const pendingId = await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(pendingId);

    await expectWidget(
      await fixture.request("custom_id=ocactivity1_mangled&instance_id=instance-1"),
      pendingId,
    );
    await expectWidget(await fixture.request("instance_id=instance-1"), newestId);
  });

  it("keeps pending launches isolated by Discord account", async () => {
    const runtime = createActivityTestRuntime();
    await recordPendingLaunch(runtime, "AAAAAAAAAAAAAAAAAAAAAA", 1, "account-b");

    await expect(consumePendingLaunch(runtime, "account-a")).resolves.toBeUndefined();
    await expect(consumePendingLaunch(runtime, "account-b")).resolves.toMatchObject({
      widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("keeps the newest-widget fallback when pending launch lookup fails", async () => {
    const logError = vi.mocked(logging.logError).mockImplementation(() => {});
    const fixture = await createWidgetFixture();
    await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    const pendingLaunchLookup = vi
      .spyOn(fixture.runtime.store, "consumePendingLaunch")
      .mockRejectedValue(new Error("store offline"));
    for (let index = 0; index < 2; index += 1) {
      await expectWidget(
        await fixture.request("custom_id=missing&instance_id=instance-1"),
        newestId,
      );
    }
    expect(pendingLaunchLookup).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("ignores a forged channel ID when no Activity instance is supplied", async () => {
    const fixture = await createWidgetFixture({});
    await fixture.widget();
    expect((await fixture.request("channel_id=777")).status).toBe(404);
  });

  it("uses the Activity Instance API channel when exactly one widget matches", async () => {
    const guard = guardedJsonFetch({ channelId: "777" });
    const fixture = await createWidgetFixture({ fetchGuard: guard });
    await fixture.widget({ channelId: "888", createdAt: 1 });
    const newestId = await fixture.widget({ channelId: "777", createdAt: 2 });
    const response = await fixture.request(
      "custom_id=missing&instance_id=instance-1&channel_id=888",
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({ id: newestId });
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://discord.com/api/v10/applications/123456789012345678/activity-instances/instance-1",
        init: expect.objectContaining({ headers: { Authorization: "Bot testtok" } }),
      }),
    );
  });

  it.each([
    { name: "outside the instance channel", channelId: "888", instanceUsers: ["42"] },
    { name: "without the session user in the instance", channelId: "777", instanceUsers: ["99"] },
  ])("rejects a custom ID $name", async ({ channelId, instanceUsers }) => {
    const fixture = await createWidgetFixture({ fetchGuard: guardedJsonFetch({ instanceUsers }) });
    const widgetId = await fixture.widget({ channelId });
    const response = await fixture.request(`custom_id=${widgetId}&instance_id=instance-1`);
    expect(response.status).toBe(404);
  });
});

describe("Discord Activity shell assets", () => {
  it("serves the generated SDK from a dist plugin root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-activity-dist-"));
    const vendorAssetPath = path.join(root, "dist/extensions/discord/assets/embedded-app-sdk.mjs");
    try {
      await fs.mkdir(path.dirname(vendorAssetPath), { recursive: true });
      await fs.writeFile(vendorAssetPath, "export class DiscordSDK {}\n");
      const base = await startServer(createRegisteredActivityFixture(undefined, vendorAssetPath));

      const vendor = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
      expect(vendor.status).toBe(200);
      await expect(vendor.text()).resolves.toContain("DiscordSDK");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves the shell and module", async () => {
    const base = await startServer(createRegisteredActivityFixture());
    const shell = await fetch(`${base}/discord/activity/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<script type="module" src="./shell.js">');
    const script = await fetch(`${base}/discord/activity/shell.js`);
    const scriptBody = await script.text();
    expect(scriptBody).toContain('from "./vendor/embedded-app-sdk.mjs"');
    expect(scriptBody).toContain("url.pathname.slice(gatewayPrefix.length)");
    expect(scriptBody).toContain("instance_id: sdk.instanceId");
    expect(scriptBody).not.toContain("channel_id: sdk.channelId");
    expect(scriptBody).toContain('frame.setAttribute("sandbox", "allow-scripts")');
  });

  it("retries the vendor asset read after a transient failure", async () => {
    const readVendorAsset = vi
      .spyOn(fs, "readFile")
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValue(Buffer.from("export class DiscordSDK {}\n"));
    const base = await startServer(createRegisteredActivityFixture());

    const first = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(first.status).toBe(404);
    const second = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(second.status).toBe(200);
    await expect(second.text()).resolves.toContain("DiscordSDK");
    expect(readVendorAsset).toHaveBeenCalledTimes(2);
  });
});
