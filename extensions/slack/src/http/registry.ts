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

// Back the route registry with a globalThis-keyed singleton. Without this,
// the provider side (loaded through the jiti plugin loader) and the dispatcher
// side (loaded lazily via native dynamic import()) end up with two separate
// module instances of this file, each with its own Map. Routes registered on
// one map are invisible to the other, so every inbound Slack webhook 404s.
const SLACK_HTTP_ROUTES_GLOBAL_KEY = Symbol.for("openclaw.slack.httpRoutes.v1");
const slackHttpRoutesGlobal = globalThis as unknown as Record<
  symbol,
  Map<string, SlackHttpRequestHandler> | undefined
>;
if (!slackHttpRoutesGlobal[SLACK_HTTP_ROUTES_GLOBAL_KEY]) {
  slackHttpRoutesGlobal[SLACK_HTTP_ROUTES_GLOBAL_KEY] = new Map<string, SlackHttpRequestHandler>();
}
const slackHttpRoutes = slackHttpRoutesGlobal[SLACK_HTTP_ROUTES_GLOBAL_KEY];

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  if (slackHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  slackHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    slackHttpRoutes.delete(normalizedPath);
  };
}

export async function handleSlackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = slackHttpRoutes.get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
