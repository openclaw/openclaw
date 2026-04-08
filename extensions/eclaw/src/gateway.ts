/**
 * Gateway lifecycle for the E-Claw channel plugin.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/architecture.md
 *       §"Channel boundary"
 *       §"Plugin SDK import paths" — lists the stable
 *         `openclaw/plugin-sdk/channel-lifecycle` and
 *         `openclaw/plugin-sdk/webhook-ingress` subpaths used here.
 *   - docs/plugins/sdk-channel-plugins.md
 *       channel plugin contract (outbound/inbound/setup) and the
 *       `waitUntilAbort` startAccount/stopAccount pattern.
 *   - docs/plugins/building-plugins.md
 *       Pre-submission checklist → "pnpm check passes (in-repo plugins)"
 *   - AGENTS.md
 *       "Channel boundary", "Architecture Boundaries" —
 *       extension-owned behavior lives in the extension; do not deep-
 *       import bundled-plugin internals from core.
 *
 * Responsibilities on startAccount:
 *   1. Resolve credentials (config + env).
 *   2. Construct an EclawClient and register it in the client registry.
 *   3. Generate a per-session callback token.
 *   4. Register the shared `/eclaw-webhook` HTTP route with the OpenClaw
 *      plugin HTTP registry (multi-account safe — every account shares the
 *      same path; dispatch is routed by the per-session Bearer token).
 *   5. POST /api/channel/register so the E-Claw backend will push webhooks
 *      to that route.
 *   6. Auto-bind an entity slot via POST /api/channel/bind.
 *   7. Keep the promise alive until the gateway aborts the account.
 *
 * Failure semantics (see PR #62934 review rounds 4–7):
 *   - Disabled / missing-apiKey → `waitUntilAbort` (opt-out, not a crash).
 *   - Route conflict / register / bind failure → clean up local state
 *     AND the remote E-Claw callback, then re-throw so the channel
 *     manager marks the account as failed and can restart it.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  readJsonWebhookBodyOrReject,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import { resolveAccount } from "./accounts.js";
import { EclawClient } from "./client.js";
import {
  clearEclawClient,
  setEclawClient,
} from "./client-registry.js";
import type { EclawInboundMessage } from "./types.js";
import { handleEclawWebhookRequest } from "./webhook-handler.js";
import {
  registerEclawWebhookToken,
  unregisterEclawWebhookToken,
} from "./webhook-registry.js";

const CHANNEL_ID = "eclaw";
const WEBHOOK_ROUTE_PATH = "/eclaw-webhook";

export type EclawGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

function formatCallbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${WEBHOOK_ROUTE_PATH}`;
}

/**
 * Shared registration count + unregister for the `/eclaw-webhook` route.
 *
 * The route is mounted once and shared across all eclaw accounts; dispatch
 * inside the handler picks the right account based on the per-session
 * Bearer token in the registry. Every startAccount call increments a
 * refcount, and the last stopAccount unregisters the underlying route.
 */
let sharedRouteRefCount = 0;
let sharedRouteUnregister: (() => void) | null = null;

function acquireSharedEclawHttpRoute(params: {
  cfg: OpenClawConfig;
  log?: EclawGatewayContext["log"];
}): () => void {
  if (sharedRouteUnregister) {
    sharedRouteRefCount += 1;
    return makeRouteRelease();
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const body = await readJsonWebhookBodyOrReject({
      req,
      res,
      emptyObjectOnEmpty: true,
    });
    if (!body.ok) {
      return;
    }
    const authHeader =
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    const result = await handleEclawWebhookRequest({
      cfg: getRuntimeConfigSnapshot() ?? params.cfg,
      authHeader,
      body: (body.value ?? {}) as EclawInboundMessage,
    });
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body));
  };

  // registerPluginHttpRoute returns a no-op unregister function if the
  // path is already claimed by another plugin (route conflict) or the
  // path is invalid / missing — it signals this via a log message
  // containing "route conflict", "route overlap denied", or "webhook path
  // missing" and never adds an entry to the registry. We MUST detect
  // that case here, because otherwise startAccount happily proceeds to
  // register/bind with the E-Claw backend and reports success while
  // inbound webhooks go nowhere.
  //
  // Sentinel pattern: wrap the log callback with a detector that sets
  // `conflict` when a known failure message flies through. Any other
  // messages (e.g. successful registration, stale-entry replacement) are
  // forwarded verbatim.
  // TypeScript's control-flow analysis doesn't track closure-mutated
  // primitives, so we use a ref-style holder to preserve the mutation
  // type without reading back as `never` after the lambda runs.
  const conflictRef: { message: string | null } = { message: null };
  const wrappedLog = (msg: string): void => {
    if (
      msg.includes("route conflict") ||
      msg.includes("route overlap denied") ||
      msg.includes("webhook path missing")
    ) {
      conflictRef.message = msg;
    }
    params.log?.info?.(msg);
  };

  const unregisterFn = registerPluginHttpRoute({
    path: WEBHOOK_ROUTE_PATH,
    auth: "plugin",
    pluginId: CHANNEL_ID,
    replaceExisting: false,
    log: wrappedLog,
    handler,
  });

  if (conflictRef.message !== null) {
    // Route registration failed. Don't keep the no-op unregister around —
    // throw so the caller (startAccount) can surface this as a real
    // startup failure, clean up its local state, and let the channel
    // manager retry or report it to the operator.
    throw new Error(
      `E-Claw: failed to register shared HTTP route ${WEBHOOK_ROUTE_PATH} — ${conflictRef.message}`,
    );
  }

  sharedRouteUnregister = unregisterFn;
  sharedRouteRefCount = 1;
  params.log?.info?.(`E-Claw: registered shared HTTP route ${WEBHOOK_ROUTE_PATH}`);
  return makeRouteRelease();
}

function makeRouteRelease(): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    sharedRouteRefCount -= 1;
    if (sharedRouteRefCount <= 0) {
      sharedRouteRefCount = 0;
      const fn = sharedRouteUnregister;
      sharedRouteUnregister = null;
      fn?.();
    }
  };
}

export async function startEclawAccount(ctx: EclawGatewayContext): Promise<unknown> {
  const { cfg, accountId, abortSignal, log } = ctx;
  const account = resolveAccount(cfg, accountId);

  if (!account.enabled) {
    log?.info?.(`E-Claw account ${accountId} disabled, skipping`);
    return waitUntilAbort(abortSignal);
  }
  if (!account.apiKey) {
    log?.warn?.(
      `E-Claw account ${accountId} missing apiKey — set channels.eclaw.apiKey or ECLAW_API_KEY`,
    );
    return waitUntilAbort(abortSignal);
  }
  if (!account.webhookUrl) {
    throw new Error(
      `E-Claw account ${accountId} missing webhookUrl — set channels.eclaw.webhookUrl or ECLAW_WEBHOOK_URL to the public base URL so the E-Claw backend can reach the webhook`,
    );
  }

  const client = new EclawClient(account);
  setEclawClient(accountId, client);

  const callbackToken = randomBytes(32).toString("hex");
  const callbackUrl = formatCallbackUrl(account.webhookUrl);

  registerEclawWebhookToken(callbackToken, accountId);

  // acquireSharedEclawHttpRoute may throw on route conflict (see
  // commit 8dfa822af5). That throw happens BEFORE the register/bind
  // try/catch below, so the webhook token and client we just stashed
  // would leak into the global registries if we didn't handle it here.
  // Guard the acquisition with an isolated try so we can roll back the
  // local state and re-throw, mirroring the cleanup in the register/
  // bind catch block. See docs/plugins/architecture.md "Channel
  // boundary" + AGENTS.md "Error handling" — a failed startup must
  // leave no trace in shared state so manager restarts are clean.
  let releaseRoute: () => void;
  try {
    releaseRoute = acquireSharedEclawHttpRoute({ cfg, log });
  } catch (err) {
    log?.error?.(
      `E-Claw setup failed for account ${accountId}: ${(err as Error).message}`,
    );
    unregisterEclawWebhookToken(callbackToken);
    clearEclawClient(accountId);
    throw err;
  }
  log?.info?.(`E-Claw webhook registered at: ${callbackUrl} (account: ${accountId})`);

  let callbackRegistered = false;
  try {
    const reg = await client.registerCallback(callbackUrl, callbackToken);
    callbackRegistered = true;
    log?.info?.(
      `E-Claw registered: deviceId=${reg.deviceId} entities=${reg.entities.length}`,
    );

    const bind = await client.bindEntity(undefined, account.botName);
    log?.info?.(
      `E-Claw bound slot ${bind.entityId} (publicCode=${bind.publicCode}) for account ${accountId}`,
    );
  } catch (err) {
    log?.error?.(
      `E-Claw setup failed for account ${accountId}: ${(err as Error).message}`,
    );
    // If registerCallback succeeded but a later step (e.g. bindEntity)
    // failed, the E-Claw backend still holds a stale callback for this
    // deviceId. Best-effort unregister so we don't leak server state.
    if (callbackRegistered) {
      await client.unregisterCallback().catch(() => {
        /* best-effort */
      });
    }
    unregisterEclawWebhookToken(callbackToken);
    releaseRoute();
    clearEclawClient(accountId);
    // Re-throw so the channel manager sees the failure, marks the account
    // as failed, and can attempt a restart. Returning `waitUntilAbort` here
    // would leave the startup task alive forever and the manager would never
    // know setup failed.
    throw err;
  }

  return waitUntilAbort(abortSignal, async () => {
    log?.info?.(`Stopping E-Claw account ${accountId}`);
    await client.unregisterCallback().catch(() => {
      /* best-effort — don't block stop on network failure */
    });
    unregisterEclawWebhookToken(callbackToken);
    releaseRoute();
    clearEclawClient(accountId);
  });
}

export async function stopEclawAccount(ctx: EclawGatewayContext): Promise<void> {
  ctx.log?.info?.(`E-Claw account ${ctx.accountId} stopped`);
}

/** Test-only: reset the shared-route refcount between test cases. */
export function __resetEclawSharedRouteForTests(): void {
  sharedRouteRefCount = 0;
  const fn = sharedRouteUnregister;
  sharedRouteUnregister = null;
  fn?.();
}
