import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeSlackWebhookPath } from "./paths.js";

export { normalizeSlackWebhookPath } from "./paths.js";

export type SlackHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterSlackHttpHandlerArgs = {
  path?: string | null;
  handler: SlackHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};

const SLACK_HTTP_ROUTES_KEY = Symbol.for("openclaw.slackHttpRoutes");

function getSlackHttpRoutes(): Map<string, SlackHttpRequestHandler> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[SLACK_HTTP_ROUTES_KEY] as Map<string, SlackHttpRequestHandler> | undefined;
  if (existing instanceof Map) {
    return existing;
  }
  const slackHttpRoutes = new Map<string, SlackHttpRequestHandler>();
  globalStore[SLACK_HTTP_ROUTES_KEY] = slackHttpRoutes;
  return slackHttpRoutes;
}

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  if (getSlackHttpRoutes().has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  getSlackHttpRoutes().set(normalizedPath, params.handler);
  return () => {
    getSlackHttpRoutes().delete(normalizedPath);
  };
}

export async function handleSlackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = getSlackHttpRoutes().get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
