import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveClickClackAccount } from "./accounts.js";
import { resolveClickClackCommandSuggestions } from "./command-suggestions.js";
import { getClickClackRuntime } from "./runtime.js";
import type { ClickClackUser, CoreConfig } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

export type ClickClackCommandSuggestionsHttpApi = {
  config?: unknown;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
};

type RequestBody = {
  accountId?: string | null;
  query?: string;
  senderId?: string;
  sender?: Partial<ClickClackUser>;
  channelId?: string;
  channelName?: string;
  directConversationId?: string;
  workspaceId?: string;
  limit?: number;
};

export function registerClickClackCommandSuggestionsRoute(api: {
  registerHttpRoute: (params: {
    path: string;
    auth: "plugin" | "gateway";
    gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
  }) => void;
  config?: unknown;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
}): void {
  api.registerHttpRoute({
    path: "/clickclack/commands/suggest",
    auth: "gateway",
    gatewayRuntimeScopeSurface: "trusted-operator",
    handler: (req, res) => handleClickClackCommandSuggestionsHttp(api, req, res),
  });
}

export async function handleClickClackCommandSuggestionsHttp(
  api: ClickClackCommandSuggestionsHttpApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method not allowed" });
    return true;
  }
  let body: RequestBody;
  try {
    body = parseRequestBody(await readBody(req));
  } catch (error) {
    writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid request body" });
    return true;
  }
  const cfg = resolveCurrentConfig(api);
  if (!cfg) {
    writeJson(res, 503, { error: "OpenClaw config is unavailable" });
    return true;
  }
  const account = resolveClickClackAccount({ cfg, accountId: body.accountId });
  const workspace = normalizeString(body.workspaceId) || account.workspace;
  const query = normalizeString(body.query);
  const senderId = normalizeString(body.senderId);
  if (!query || !senderId) {
    writeJson(res, 200, { query, suggestions: [] });
    return true;
  }
  const response = resolveClickClackCommandSuggestions({
    account: { ...account, workspace },
    config: cfg,
    query,
    senderId,
    sender: body.sender,
    channelId: normalizeString(body.channelId),
    channelName: normalizeString(body.channelName),
    directConversationId: normalizeString(body.directConversationId),
    limit: normalizeLimit(body.limit),
  });
  writeJson(res, 200, response);
  return true;
}

function resolveCurrentConfig(api: ClickClackCommandSuggestionsHttpApi): CoreConfig | undefined {
  try {
    return getClickClackRuntime().config.current() as CoreConfig;
  } catch {
    return api.config as CoreConfig | undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequestBody(raw: string): RequestBody {
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }
  return parsed as RequestBody;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(Math.trunc(value), 50));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
