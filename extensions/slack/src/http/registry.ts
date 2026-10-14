import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
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

const slackHttpRoutes = resolveGlobalMap<string, SlackHttpRequestHandler>(
  Symbol.for("openclaw.slack.httpRoutes.v1"),
);

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  const routes = slackHttpRoutes;
  if (routes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  const handler = params.handler;
  routes.set(normalizedPath, handler);
  let registered = true;
  return () => {
    if (!registered) {
      return;
    }
    registered = false;
    if (routes.get(normalizedPath) === handler) {
      routes.delete(normalizedPath);
    }
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
