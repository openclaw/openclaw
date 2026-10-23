import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeBoundedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsAsciiControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import { resolveRequestClientIp } from "openclaw/plugin-sdk/webhook-ingress";
import {
  readJsonBodyWithLimit,
  sendHttpRequestRejection,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { WIDGET_CDN_ORIGINS } from "openclaw/plugin-sdk/widget-html";
import { parseDiscordActivityCustomId } from "../component-custom-id.js";
import { getDiscordEndpointRuntime, type DiscordEndpointRuntime } from "../endpoint-runtime.js";
import type { sendDiscordComponentMessage } from "../send.components.js";
import { buildDiscordPresentationComponents } from "../shared-interactive.js";
import { resolveDiscordChannelId as resolveDiscordTargetChannelId } from "../target-parsing.js";
import { TokenRateLimiter } from "./rate-limit.js";
import { DiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import {
  DISCORD_ACTIVITY_ROUTE_PREFIX,
  DISCORD_ACTIVITY_SHELL_CSP,
  DISCORD_ACTIVITY_SHELL_HTML,
  DISCORD_ACTIVITY_SHELL_JS,
} from "./shell.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";

const BODY_MAX_BYTES = 8 * 1024;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DOC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_USER_URL = "https://discord.com/api/v10/users/@me";
const DISCORD_HOST = "discord.com";
const DISCORD_ACTIVITY_REQUEST_TIMEOUT_MS = 15_000;
const JSON_MAX_BYTES = 64 * 1024;
const INSTANCE_ID_MAX_LENGTH = 256;

function normalizeInstanceId(value: string | null): string | undefined {
  const instanceId = normalizeBoundedOptionalString(value, INSTANCE_ID_MAX_LENGTH);
  return instanceId && !containsAsciiControlCharacter(instanceId) ? instanceId : undefined;
}

async function fetchDiscordJson(params: {
  fetchImpl?: typeof fetch;
  url: string;
  init: RequestInit;
  auditContext: string;
  endpointRuntime?: DiscordEndpointRuntime | null;
}): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  const endpoint = Object.hasOwn(params, "endpointRuntime")
    ? params.endpointRuntime
    : getDiscordEndpointRuntime();
  const liveUrl = new URL(params.url);
  const endpointPath =
    liveUrl.pathname === "/api/oauth2/token"
      ? "/oauth2/token"
      : liveUrl.pathname.startsWith("/api/v10/")
        ? liveUrl.pathname.slice("/api/v10".length)
        : undefined;
  if (endpoint && !endpointPath) {
    throw new Error("Discord Activity request is outside the configured endpoint routes");
  }
  const guarded = endpoint
    ? {
        response: await endpoint.fetch(
          `${endpoint.descriptor.restApiBaseUrl}${endpointPath}${liveUrl.search}`,
          {
            ...params.init,
            signal: params.init.signal
              ? AbortSignal.any([
                  params.init.signal,
                  AbortSignal.timeout(DISCORD_ACTIVITY_REQUEST_TIMEOUT_MS),
                ])
              : AbortSignal.timeout(DISCORD_ACTIVITY_REQUEST_TIMEOUT_MS),
          },
        ),
        release: async () => {},
      }
    : await fetchWithSsrFGuard({
        url: params.url,
        fetchImpl: params.fetchImpl,
        init: params.init,
        policy: { allowedHostnames: [DISCORD_HOST] },
        auditContext: params.auditContext,
        timeoutMs: DISCORD_ACTIVITY_REQUEST_TIMEOUT_MS,
      });
  const { response, release } = guarded;
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    return {
      ok: true,
      body: await readProviderJsonResponse<Record<string, unknown>>(
        response,
        "Discord Activity OAuth",
        { maxBytes: JSON_MAX_BYTES },
      ),
    };
  } finally {
    await release();
  }
}

const DISCORD_ACTIVITY_WIDGET_CSP =
  // Discord is an ancestor of the same-origin Activity shell, so every frame ancestor must pass.
  // The one-time document capability and nested sandbox remain the embedding boundary.
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${WIDGET_CDN_ORIGINS.join(" ")}; ` +
  `style-src 'unsafe-inline' ${WIDGET_CDN_ORIGINS.join(" ")}; img-src data: blob:; font-src data: ${WIDGET_CDN_ORIGINS.join(" ")}; ` +
  "connect-src 'none'; frame-ancestors *";

function respond(
  res: ServerResponse,
  statusCode: number,
  body: string | Buffer,
  contentType: string,
  headers?: Record<string, string>,
): true {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", contentType);
  for (const [key, value] of Object.entries(headers ?? {})) {
    res.setHeader(key, value);
  }
  res.end(body);
  return true;
}

function jsonBody(body: unknown): string {
  return `${JSON.stringify(body)}\n`;
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): true {
  return respond(res, statusCode, jsonBody(body), JSON_CONTENT_TYPE);
}

function notFound(res: ServerResponse, widgetDocument = false): true {
  // Indistinguishable 404s prevent document-capability probes from revealing widget state.
  return respond(
    res,
    404,
    "not found",
    "text/plain; charset=utf-8",
    widgetDocument ? { "Content-Security-Policy": DISCORD_ACTIVITY_WIDGET_CSP } : undefined,
  );
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function extractApplicationId(req: IncomingMessage): string | undefined {
  for (const header of [readHeader(req, "origin"), readHeader(req, "referer")]) {
    if (!header) {
      continue;
    }
    try {
      const match = new URL(header).hostname.match(/^(\d+)\.discordsays\.com$/i);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // Invalid Origin metadata may still have a valid Referer fallback.
    }
  }
  return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = readHeader(req, "authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/i);
  return match?.[1];
}

const DISCORD_WIDGET_HTML_MAX_BYTES = 48 * 1024;

type WidgetPresenter = Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0];
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];

const unavailable = () => ({
  ok: false as const,
  error: {
    code: "unavailable" as const,
    message: "Discord Activities are unavailable for the current channel and account.",
  },
});

function resolveDiscordChannelId(context: WidgetPresenterContext): string | undefined {
  const raw =
    context.nativeChannelId?.trim() ||
    context.currentMessagingTarget?.trim() ||
    context.currentChannelId?.trim() ||
    context.deliveryContext?.to?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return resolveDiscordTargetChannelId(raw);
  } catch {
    return undefined;
  }
}

function resolveDiscordPresentationRoute(
  context: WidgetPresenterContext,
  runtime: DiscordActivitiesRuntime,
) {
  if (context.messageChannel !== "discord") {
    return undefined;
  }
  const cfg = runtime.currentConfig();
  const channelId = resolveDiscordChannelId(context);
  const activityAccount = runtime.resolveAccount(
    context.accountId ?? context.deliveryContext?.accountId,
    cfg,
  );
  if (!channelId || !activityAccount) {
    return undefined;
  }
  return { account: activityAccount, cfg, channelId };
}

export function registerDiscordActivities(api: OpenClawPluginApi): void {
  setDiscordActivitiesRuntime(undefined);
  // Registration precedes publication of secret-resolved channel config. Keep the
  // transport static; runtime matching and HTTP dispatch gate on the current snapshot.
  const store = new DiscordActivityStore(
    openDiscordActivityStores(api.runtime.state.openKeyedStoreV2.bind(api.runtime.state)),
  );
  const runtime = new DiscordActivitiesRuntime(
    store,
    () => api.runtime.config.current() as typeof api.config,
  );
  setDiscordActivitiesRuntime(runtime);
  const vendorAssetPath = api.resolvePath("assets/embedded-app-sdk.mjs");
  const limiter = new TokenRateLimiter();
  // The OAuth code body is unauthenticated and tiny. Reuse the pre-auth webhook budget so a
  // stalled upload cannot retain a Gateway handler indefinitely.
  const bodyTimeoutMs = WEBHOOK_BODY_READ_DEFAULTS.preAuth.timeoutMs;
  let vendorAsset: Promise<Buffer> | undefined;
  let pendingLaunchFailureLogged = false;

  function logPendingLaunchFailure(error: unknown): void {
    if (pendingLaunchFailureLogged) {
      return;
    }
    pendingLaunchFailureLogged = true;
    logError(`discord activity: failed to consume pending launch: ${String(error)}`);
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const cfg = runtime.currentConfig();
    const sourceIp =
      resolveRequestClientIp(
        req,
        cfg.gateway?.trustedProxies,
        cfg.gateway?.allowRealIpFallback === true,
      ) ?? "unknown";
    if (!limiter.allowKey(sourceIp)) {
      return respondJson(res, 429, { error: "too many token requests" });
    }
    const applicationId = extractApplicationId(req);
    const account = runtime.resolveHttpAccount(applicationId);
    if (!account) {
      return respondJson(res, 503, { error: "Discord Activities is not fully configured" });
    }
    const endpointRuntime = getDiscordEndpointRuntime() ?? null;
    const fetchAccountJson = (
      params: Pick<Parameters<typeof fetchDiscordJson>[0], "url" | "init" | "auditContext">,
    ) =>
      fetchDiscordJson({
        ...params,
        fetchImpl: account.proxyFetch,
        endpointRuntime,
      }).catch(() => undefined);
    const bodyResult = await readJsonBodyWithLimit(req, {
      maxBytes: BODY_MAX_BYTES,
      timeoutMs: bodyTimeoutMs,
      emptyObjectOnEmpty: true,
      // Defer destruction so the rejections below reach the client before the close.
      destroyOnLimit: false,
    });
    if (
      !bodyResult.ok &&
      (bodyResult.code === "REQUEST_BODY_TIMEOUT" || bodyResult.code === "PAYLOAD_TOO_LARGE")
    ) {
      const timedOut = bodyResult.code === "REQUEST_BODY_TIMEOUT";
      await sendHttpRequestRejection(
        req,
        res,
        timedOut ? 408 : 413,
        jsonBody({ error: timedOut ? "request body timeout" : "request body too large" }),
        JSON_CONTENT_TYPE,
      );
      return true;
    }
    const body = bodyResult.ok ? asOptionalRecord(bodyResult.value) : undefined;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) {
      return respondJson(res, 401, { error: "invalid authorization code" });
    }
    const reservation = limiter.reserveGlobal();
    if (reservation === null) {
      return respondJson(res, 429, { error: "too many token requests" });
    }
    let completed = false;
    try {
      const tokenResponse = await fetchAccountJson({
        url: DISCORD_TOKEN_URL,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: account.applicationId,
            client_secret: account.clientSecret,
            code,
          }),
        },
        auditContext: "discord.activities.oauth.token",
      });
      if (!tokenResponse) {
        return respondJson(res, 503, { error: "Discord token exchange unavailable" });
      }
      const granted =
        typeof tokenResponse.body?.access_token === "string"
          ? tokenResponse.body.access_token.trim()
          : "";
      if (!tokenResponse.ok || !granted) {
        return respondJson(res, 401, { error: "invalid authorization code" });
      }
      const userResponse = await fetchAccountJson({
        url: DISCORD_USER_URL,
        init: { headers: { Authorization: `Bearer ${granted}` } },
        auditContext: "discord.activities.oauth.user",
      });
      if (!userResponse) {
        return respondJson(res, 503, { error: "Discord user lookup unavailable" });
      }
      const discordUserId =
        typeof userResponse.body?.id === "string" ? userResponse.body.id : undefined;
      if (!userResponse.ok || !discordUserId) {
        return respondJson(res, 401, { error: "Discord user lookup failed" });
      }
      const minted = await runtime.store.createSession({
        discordUserId,
        accountId: account.accountId,
      });
      completed = true;
      return respondJson(res, 200, {
        access_token: granted,
        session_token: minted,
      });
    } finally {
      if (!completed) {
        limiter.releaseGlobal(reservation);
      }
    }
  }

  async function handleWidget(req: IncomingMessage, res: ServerResponse, url: URL): Promise<true> {
    const token = bearerToken(req);
    const session = token ? await runtime.store.lookupSession(token) : undefined;
    if (!session) {
      return respondJson(res, 401, { error: "invalid session" });
    }
    const customId = url.searchParams.get("custom_id")?.trim() ?? "";
    const instanceId = normalizeInstanceId(url.searchParams.get("instance_id"));
    const account = runtime.resolveAccount(session.accountId);
    let channelId: string | undefined;
    if (instanceId && account) {
      const discordUserId = session.discordUserId;
      const endpointRuntime = getDiscordEndpointRuntime() ?? null;
      const result = await fetchDiscordJson({
        fetchImpl: account.proxyFetch,
        url: `https://discord.com/api/v10/applications/${encodeURIComponent(account.applicationId)}/activity-instances/${encodeURIComponent(instanceId)}`,
        init: { headers: { Authorization: `Bot ${account.botAuth}` } },
        auditContext: "discord.activities.instance",
        endpointRuntime,
      }).catch(() => undefined);
      if (
        result?.ok &&
        Array.isArray(result.body?.users) &&
        result.body.users.includes(discordUserId)
      ) {
        const value = asOptionalRecord(result.body.location)?.channel_id;
        channelId = typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
      }
    }
    if (!channelId) {
      return respondJson(res, 404, { error: "widget not found" });
    }
    let resolved: {
      id: string;
      widget: NonNullable<Awaited<ReturnType<typeof runtime.store.lookupWidget>>>;
    } | null = null;
    // Prefer an explicit ID, then the click-time launch record, then the newest posted widget.
    const requestedWidgetId = WIDGET_ID_PATTERN.test(customId)
      ? customId
      : parseDiscordActivityCustomId(customId)?.widgetId;
    if (requestedWidgetId) {
      const widget = await runtime.store.lookupWidget(requestedWidgetId);
      // A parseable ID is an explicit widget selection. Missing or foreign widgets fail closed
      // instead of silently opening unrelated pending or newest-widget state.
      if (widget?.accountId !== session.accountId || widget.channelId !== channelId) {
        return respondJson(res, 404, { error: "widget not found" });
      }
      resolved = { id: requestedWidgetId, widget };
      // Awaited like every sibling store call on this path (sessions, widgets): the local
      // KV either answers or the process is wedged; per-call budgets here would be asymmetric.
      try {
        await runtime.store.retirePendingLaunch(
          session.accountId,
          channelId,
          session.discordUserId,
          requestedWidgetId,
        );
      } catch (error) {
        logPendingLaunchFailure(error);
      }
    } else {
      try {
        const pendingLaunch = await runtime.store.consumePendingLaunch(
          session.accountId,
          channelId,
          session.discordUserId,
        );
        if (pendingLaunch) {
          const widget = await runtime.store.lookupWidget(pendingLaunch.widgetId);
          if (widget?.accountId === session.accountId && widget.channelId === channelId) {
            resolved = { id: pendingLaunch.widgetId, widget };
          }
        }
      } catch (error) {
        logPendingLaunchFailure(error);
      }
      // Some Discord clients omit the launch custom ID. Prefer the most recently posted channel
      // widget while keeping older widgets addressable through buttons that preserve custom IDs.
      resolved ??= await runtime.store.latestPostedWidgetForChannel(session.accountId, channelId);
    }
    if (!resolved) {
      return respondJson(res, 404, { error: "widget not found" });
    }
    const docToken = await runtime.store.createDocToken({
      widgetId: resolved.id,
      accountId: session.accountId,
    });
    return respondJson(res, 200, {
      id: resolved.id,
      title: resolved.widget.title,
      docUrl: `${DISCORD_ACTIVITY_ROUTE_PREFIX}/api/widget/${encodeURIComponent(resolved.id)}/doc?wt=${encodeURIComponent(docToken)}`,
    });
  }

  async function handleDocument(
    res: ServerResponse,
    widgetId: string,
    token: string,
  ): Promise<true> {
    if (!WIDGET_ID_PATTERN.test(widgetId) || !DOC_TOKEN_PATTERN.test(token)) {
      return notFound(res, true);
    }
    // Consume before lookup: a valid capability is single-use even if its widget was evicted.
    const capability = await runtime.store.consumeDocToken(token);
    if (!capability || capability.widgetId !== widgetId) {
      return notFound(res, true);
    }
    const widget = await runtime.store.lookupWidget(widgetId);
    if (!widget || widget.accountId !== capability.accountId) {
      return notFound(res, true);
    }
    return respond(res, 200, widget.html, "text/html; charset=utf-8", {
      "Content-Security-Policy": DISCORD_ACTIVITY_WIDGET_CSP,
    });
  }

  api.registerHttpRoute({
    path: DISCORD_ACTIVITY_ROUTE_PREFIX,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        url.pathname !== DISCORD_ACTIVITY_ROUTE_PREFIX &&
        !url.pathname.startsWith(`${DISCORD_ACTIVITY_ROUTE_PREFIX}/`)
      ) {
        return false;
      }
      // Keep the public prefix indistinguishable from an unregistered route until
      // at least one current account enables Activities.
      if (!runtime.hasEnabledAccounts()) {
        return false;
      }
      const relative = url.pathname.slice(DISCORD_ACTIVITY_ROUTE_PREFIX.length) || "/";
      if (req.method === "GET" && (relative === "/" || relative === "/index.html")) {
        return respond(res, 200, DISCORD_ACTIVITY_SHELL_HTML, "text/html; charset=utf-8", {
          "Content-Security-Policy": DISCORD_ACTIVITY_SHELL_CSP,
        });
      }
      if (req.method === "GET" && relative === "/shell.js") {
        return respond(res, 200, DISCORD_ACTIVITY_SHELL_JS, "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && relative === "/vendor/embedded-app-sdk.mjs") {
        const pendingAsset = (vendorAsset ??= fs.readFile(vendorAssetPath));
        try {
          return respond(res, 200, await pendingAsset, "text/javascript; charset=utf-8");
        } catch {
          // Clear only the failed read. A later request may already have installed a retry.
          if (vendorAsset === pendingAsset) {
            vendorAsset = undefined;
          }
          return notFound(res);
        }
      }
      if (req.method === "POST" && relative === "/api/token") {
        return await handleToken(req, res);
      }
      if (req.method === "GET" && relative === "/api/widget") {
        return await handleWidget(req, res, url);
      }
      const documentMatch = relative.match(/^\/api\/widget\/([^/]+)\/doc$/);
      if (req.method === "GET" && documentMatch?.[1]) {
        let widgetId: string;
        try {
          widgetId = decodeURIComponent(documentMatch[1]);
        } catch {
          return notFound(res, true);
        }
        return await handleDocument(res, widgetId, url.searchParams.get("wt") ?? "");
      }
      return notFound(res);
    },
  });

  /** Presents a canonical core widget document in the active Discord channel. */
  api.registerWidgetPresenter({
    target: "current_channel",
    description: "Post an Activity launch button in the current Discord channel",
    capabilities: {
      sourceKinds: ["html"],
      maxSourceBytes: DISCORD_WIDGET_HTML_MAX_BYTES,
    },
    match: (context) => resolveDiscordPresentationRoute(context, runtime) !== undefined,
    async availability(context) {
      return resolveDiscordPresentationRoute(context, runtime)
        ? { ok: true, value: { available: true } }
        : unavailable();
    },
    async present({ context, document, title }) {
      const route = resolveDiscordPresentationRoute(context, runtime);
      if (!route) {
        return unavailable();
      }
      if (Array.from(title).length > 80) {
        return {
          ok: false,
          error: { code: "presentation_error", message: "title must be 80 characters or fewer" },
        };
      }

      // Persist before the button can be delivered so a launch never races an absent record;
      // roll the record back if the post fails so a failed send leaves no unreachable widget.
      const widgetId = await runtime.store.createWidget({
        html: document.html,
        title,
        channelId: route.channelId,
        accountId: route.account.accountId,
        createdAt: Date.now(),
      });
      let result: Awaited<ReturnType<typeof sendDiscordComponentMessage>>;
      let deliveredResult: Awaited<ReturnType<typeof sendDiscordComponentMessage>> | undefined;
      let deliveryRecord: Promise<void> | undefined;
      const recordDelivery = (
        deliveryResult: Awaited<ReturnType<typeof sendDiscordComponentMessage>>,
      ) => {
        deliveredResult = deliveryResult;
        return (deliveryRecord ??= runtime.store
          .markWidgetDelivered(widgetId, deliveryResult.messageId)
          .catch((error: unknown) => {
            throw new Error(
              "Discord widget was delivered, but its delivery state could not be saved",
              { cause: error },
            );
          }));
      };
      try {
        const components = buildDiscordPresentationComponents({
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Open widget",
                  action: { type: "web-app", widgetId },
                },
              ],
            },
          ],
        });
        if (!components) {
          throw new Error("Discord widget launch button could not be rendered");
        }
        const { sendDiscordComponentMessage } = await import("../send.components.js");
        result = await sendDiscordComponentMessage(
          `channel:${route.channelId}`,
          { ...components, text: title },
          {
            cfg: route.cfg,
            accountId: route.account.accountId,
            allowedMentions: { parse: [] },
            onDeliveryResult: recordDelivery,
          },
        );
        await recordDelivery(result);
      } catch (error) {
        if (!deliveredResult) {
          await runtime.store.deleteWidget(widgetId);
          throw error;
        }
        // Retain delivered widgets, but never hide a failed delivery-state write.
        await deliveryRecord;
        result = deliveredResult;
      }
      return { ok: true, value: { kind: "message", receipt: result.receipt } };
    },
  });
}
