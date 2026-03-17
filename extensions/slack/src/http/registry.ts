import type { IncomingMessage, ServerResponse } from "node:http";

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

// Use globalThis to ensure a single shared Map across all bundled module instances.
// Without this, the bundler may duplicate this module into multiple chunks, causing
// registerSlackHttpHandler and handleSlackHttpRequest to operate on different Maps.
const GLOBAL_KEY = Symbol.for("openclaw.slack.httpRoutes");
type GlobalWithRoutes = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, SlackHttpRequestHandler>;
};
const slackHttpRoutes: Map<string, SlackHttpRequestHandler> = ((globalThis as GlobalWithRoutes)[
  GLOBAL_KEY
] ??= new Map());

export function normalizeSlackWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "/slack/events";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

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
