/**
 * Inbound webhook handler for MagicForm.
 * Parses JSON body, validates token, delivers to agent, sends callback.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/magicform";
import { sendCallback } from "./client.js";
import { validateToken, authorizeStackId, sanitizeInput, RateLimiter } from "./security.js";
import type { ResolvedMagicFormAccount, MagicFormWebhookPayload } from "./types.js";

const rateLimiters = new Map<string, RateLimiter>();

function getRateLimiter(account: ResolvedMagicFormAccount): RateLimiter {
  let rl = rateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
    rl?.clear();
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}

export function clearMagicFormWebhookRateLimiterStateForTest(): void {
  for (const limiter of rateLimiters.values()) {
    limiter.clear();
  }
  rateLimiters.clear();
}

async function readBody(req: IncomingMessage): Promise<
  | { ok: true; body: string }
  | { ok: false; statusCode: number; error: string }
> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 1_048_576,
      timeoutMs: 30_000,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code),
      };
    }
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  const headerValue = Array.isArray(auth) ? auth[0] : auth;
  const match = headerValue?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function parsePayload(body: string): MagicFormWebhookPayload | null {
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  const stackId = typeof parsed.stack_id === "string" ? parsed.stack_id.trim() : "";
  const conversationId = typeof parsed.conversation_id === "string" ? parsed.conversation_id.trim() : "";
  const userId = typeof parsed.user_id === "string" ? parsed.user_id.trim() : "";

  if (!message || !stackId || !conversationId || !userId) return null;

  return {
    message,
    stack_id: stackId,
    conversation_id: conversationId,
    user_id: userId,
    user_name: typeof parsed.user_name === "string" ? parsed.user_name.trim() : undefined,
    workspace: typeof parsed.workspace === "string" ? parsed.workspace.trim() : undefined,
    config_dir: typeof parsed.config_dir === "string" ? parsed.config_dir.trim() : undefined,
    tools_profile: typeof parsed.tools_profile === "string" ? parsed.tools_profile.trim() : undefined,
    tools_allow: Array.isArray(parsed.tools_allow)
      ? parsed.tools_allow.filter((s: unknown): s is string => typeof s === "string")
      : undefined,
    tools_deny: Array.isArray(parsed.tools_deny)
      ? parsed.tools_deny.filter((s: unknown): s is string => typeof s === "string")
      : undefined,
    metadata: typeof parsed.metadata === "object" && parsed.metadata ? parsed.metadata : undefined,
  };
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface WebhookHandlerDeps {
  account: ResolvedMagicFormAccount;
  deliver: (msg: {
    body: string;
    from: string;
    senderName: string;
    provider: string;
    chatType: string;
    sessionKey: string;
    accountId: string;
    /** Per-request overrides from webhook payload. */
    workspaceOverride?: string;
    configDirOverride?: string;
    toolsProfileOverride?: string;
    toolsAllowOverride?: string[];
    toolsDenyOverride?: string[];
  }) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Create an HTTP request handler for MagicForm inbound webhooks.
 *
 * This handler:
 * 1. Parses JSON payload
 * 2. Validates Bearer token
 * 3. Checks stack_id against allow_from
 * 4. Rate limits by stack_id:conversation_id
 * 5. ACKs immediately (202)
 * 6. Delivers to agent asynchronously
 * 7. Sends response back to MagicForm callback
 */
export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      log?.error("Failed to read request body", bodyResult.error);
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }

    // Validate Bearer token
    const token = extractBearerToken(req);
    if (!token || !validateToken(token, account.apiToken)) {
      log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
      respondJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Parse payload
    let payload: MagicFormWebhookPayload | null = null;
    try {
      payload = parsePayload(bodyResult.body);
    } catch (err) {
      log?.warn("Failed to parse webhook payload", err);
      respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!payload) {
      respondJson(res, 400, { error: "Missing required fields (message, stack_id, conversation_id, user_id)" });
      return;
    }

    // Check stack_id against allow_from
    const auth = authorizeStackId(payload.stack_id, account.allowFrom);
    if (!auth.allowed) {
      log?.warn(`Stack ${payload.stack_id} not in allow_from`);
      respondJson(res, 403, { error: "Stack not authorized" });
      return;
    }

    // Rate limit
    const rateLimitKey = `${payload.stack_id}:${payload.conversation_id}`;
    if (!rateLimiter.check(rateLimitKey)) {
      log?.warn(`Rate limit exceeded for ${rateLimitKey}`);
      respondJson(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    // Sanitize input
    const cleanMessage = sanitizeInput(payload.message);
    if (!cleanMessage) {
      respondJson(res, 202, { ok: true });
      return;
    }

    const preview = cleanMessage.length > 100 ? `${cleanMessage.slice(0, 100)}...` : cleanMessage;
    log?.info(`Message from ${payload.user_name ?? payload.user_id} (stack: ${payload.stack_id}): ${preview}`);

    // ACK immediately
    respondJson(res, 202, { ok: true });

    // Deliver to agent asynchronously.
    // The dispatcher's deliver callback (in channel.ts) handles sending responses
    // back to MagicForm via sendCallback. This handler only needs to handle errors.
    const sessionKey = `magicform:${payload.stack_id}:${payload.conversation_id}`;
    const toField = `${payload.stack_id}:${payload.conversation_id}:${payload.user_id}`;

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent response timeout (300s)")), 300_000);
      });

      try {
        await Promise.race([
          deliver({
            body: cleanMessage,
            from: toField,
            senderName: payload.user_name ?? payload.user_id,
            provider: "magicform",
            chatType: "direct",
            sessionKey,
            accountId: account.accountId,
            workspaceOverride: payload.workspace,
            configDirOverride: payload.config_dir,
            toolsProfileOverride: payload.tools_profile,
            toolsAllowOverride: payload.tools_allow,
            toolsDenyOverride: payload.tools_deny,
          }),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error(`Failed to process message for ${payload.conversation_id}: ${errMsg}`);
      await sendCallback(account.backendUrl, account.callbackPath, {
        stack_id: payload.stack_id,
        conversation_id: payload.conversation_id,
        user_id: payload.user_id,
        response: "",
        status: "error",
        error: errMsg,
        metadata: payload.metadata,
      }, account.apiToken);
    }
  };
}
