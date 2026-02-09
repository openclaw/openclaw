import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedInfoflowAccount } from "./channel.js";
import {
  parseAndDispatchInfoflowRequest,
  readRawBody,
  type WebhookTarget,
} from "./infoflow_req_parse.js";
import { getInfoflowRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InfoflowCoreRuntime = ReturnType<typeof getInfoflowRuntime>;

export type InfoflowMonitorOptions = {
  account: ResolvedInfoflowAccount;
  config: OpenClawConfig;
  runtime: unknown;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** webhook path for Infoflow. */
const INFOFLOW_WEBHOOK_PATH = "/webhook/infoflow";

// ---------------------------------------------------------------------------
// Webhook target registry
// ---------------------------------------------------------------------------

const webhookTargets = new Map<string, WebhookTarget[]>();

/** Normalizes a webhook path: trim, ensure leading slash, strip trailing slash (except "/"). */
function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

/** Registers a webhook target for a path. Returns an unregister function to remove it. */
function registerInfoflowWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP handler (registered via api.registerHttpHandler)
// ---------------------------------------------------------------------------

/**
 * Checks if the request path matches a registered Infoflow webhook path.
 */
function isInfoflowPath(requestPath: string): boolean {
  const normalized = normalizeWebhookPath(requestPath);
  return webhookTargets.has(normalized);
}

/**
 * Handles incoming Infoflow webhook HTTP requests.
 *
 * - Routes by path to registered targets (supports exact and suffix match).
 * - Only allows POST.
 * - Delegates body reading, echostr verification, authentication,
 *   and message dispatch to infoflow_req_parse.
 */
export async function handleInfoflowWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const core = getInfoflowRuntime();
  const verbose = core.logging.shouldLogVerbose();

  const url = new URL(req.url ?? "/", "http://localhost");
  const requestPath = normalizeWebhookPath(url.pathname);

  if (verbose) {
    console.log(`[infoflow] webhook request: method=${req.method}, path=${requestPath}`);
  }

  // Check if path matches Infoflow webhook pattern
  if (!isInfoflowPath(requestPath)) {
    if (verbose) {
      console.log(`[infoflow] path not matched, skipping`);
    }
    return false;
  }

  // Get registered targets for the actual request path
  const targets = webhookTargets.get(requestPath);
  if (!targets || targets.length === 0) {
    if (verbose) {
      console.log(`[infoflow] no targets registered for path=${requestPath}`);
    }
    return false;
  }

  if (verbose) {
    console.log(`[infoflow] found ${targets.length} target(s) for path=${requestPath}`);
  }

  if (req.method !== "POST") {
    if (verbose) {
      console.log(`[infoflow] rejected: method ${req.method} not allowed`);
    }
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  // Read raw body once
  if (verbose) {
    console.log(`[infoflow] reading request body...`);
  }
  const bodyResult = await readRawBody(req);
  if (!bodyResult.ok) {
    console.error(`[infoflow] failed to read body: ${bodyResult.error}`);
    res.statusCode = bodyResult.error === "payload too large" ? 413 : 400;
    res.end(bodyResult.error);
    return true;
  }

  if (verbose) {
    console.log(`[infoflow] body read success, length=${bodyResult.raw.length}, dispatching...`);
  }

  const result = await parseAndDispatchInfoflowRequest(req, bodyResult.raw, targets);

  if (verbose) {
    console.log(
      `[infoflow] dispatch result: handled=${result.handled}, status=${result.statusCode}`,
    );
  }

  if (result.handled) {
    res.statusCode = result.statusCode;
    if (result.statusCode === 200 && result.body.startsWith("{")) {
      res.setHeader("Content-Type", "application/json");
    }
    res.end(result.body);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Monitor lifecycle
// ---------------------------------------------------------------------------

/** Registers this account's webhook target and returns an unregister (stop) function. */
export async function startInfoflowMonitor(options: InfoflowMonitorOptions): Promise<() => void> {
  const core = getInfoflowRuntime();

  const unregister = registerInfoflowWebhookTarget({
    account: options.account,
    config: options.config,
    core,
    path: INFOFLOW_WEBHOOK_PATH,
    statusSink: options.statusSink,
  });

  return unregister;
}
