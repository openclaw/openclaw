import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getMattermostRuntime } from "../runtime.js";
import { updateMattermostPost, type MattermostClient } from "./client.js";

const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 10_000;

/**
 * Mattermost interactive message callback payload.
 * Sent by Mattermost when a user clicks an action button.
 * See: https://developers.mattermost.com/integrate/plugins/interactive-messages/
 */
export type MattermostInteractionPayload = {
  user_id: string;
  user_name?: string;
  channel_id: string;
  team_id?: string;
  post_id: string;
  trigger_id?: string;
  type?: string;
  data_source?: string;
  context?: Record<string, unknown>;
};

export type MattermostInteractionResponse = {
  update?: {
    message: string;
    props?: Record<string, unknown>;
  };
  ephemeral_text?: string;
};

// ── Callback URL registry ──────────────────────────────────────────────

const callbackUrls = new Map<string, string>();

export function setInteractionCallbackUrl(accountId: string, url: string): void {
  callbackUrls.set(accountId, url);
}

export function getInteractionCallbackUrl(accountId: string): string | undefined {
  return callbackUrls.get(accountId);
}

/**
 * Resolve the interaction callback URL for an account.
 * Prefers the in-memory registered URL (set by the gateway monitor).
 * Falls back to computing it from the gateway port in config (for CLI callers).
 */
export function resolveInteractionCallbackUrl(
  accountId: string,
  cfg?: { gateway?: { port?: number } },
): string {
  const cached = callbackUrls.get(accountId);
  if (cached) {
    return cached;
  }
  const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
  return `http://localhost:${port}/mattermost/interactions/${accountId}`;
}

// ── HMAC token management ──────────────────────────────────────────────
// Secret is derived from the bot token so it's stable across CLI and gateway processes.

let interactionSecret: string | undefined;

export function setInteractionSecret(botToken: string): void {
  interactionSecret = createHmac("sha256", "openclaw-mattermost-interactions")
    .update(botToken)
    .digest("hex");
}

export function getInteractionSecret(): string {
  if (!interactionSecret) {
    throw new Error(
      "Interaction secret not initialized — call setInteractionSecret(botToken) first",
    );
  }
  return interactionSecret;
}

export function generateInteractionToken(context: Record<string, unknown>): string {
  const secret = getInteractionSecret();
  // Sort keys for stable serialization — Mattermost may reorder context keys
  const payload = JSON.stringify(context, Object.keys(context).sort());
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyInteractionToken(context: Record<string, unknown>, token: string): boolean {
  const expected = generateInteractionToken(context);
  if (expected.length !== token.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

// ── Button builder helpers ─────────────────────────────────────────────

export type MattermostButton = {
  id: string;
  type: "button" | "select";
  name: string;
  style?: "default" | "primary" | "danger";
  integration: {
    url: string;
    context: Record<string, unknown>;
  };
};

export type MattermostAttachment = {
  text?: string;
  actions?: MattermostButton[];
  [key: string]: unknown;
};

/**
 * Build Mattermost `props.attachments` with interactive buttons.
 *
 * Each button includes an HMAC token in its integration context so the
 * callback handler can verify the request originated from a legitimate
 * button click (Mattermost's recommended security pattern).
 */
/**
 * Sanitize a button ID so Mattermost's action router can match it.
 * Mattermost uses the action ID in the URL path `/api/v4/posts/{id}/actions/{actionId}`
 * and IDs containing hyphens or underscores break the server-side routing.
 * See: https://github.com/mattermost/mattermost/issues/25747
 */
function sanitizeActionId(id: string): string {
  return id.replace(/[-_]/g, "");
}

export function buildButtonAttachments(params: {
  callbackUrl: string;
  buttons: Array<{
    id: string;
    name: string;
    style?: "default" | "primary" | "danger";
    context?: Record<string, unknown>;
  }>;
  text?: string;
}): MattermostAttachment[] {
  const actions: MattermostButton[] = params.buttons.map((btn) => {
    const safeId = sanitizeActionId(btn.id);
    const context: Record<string, unknown> = {
      action_id: safeId,
      ...btn.context,
    };
    const token = generateInteractionToken(context);
    return {
      id: safeId,
      type: "button" as const,
      name: btn.name,
      style: btn.style,
      integration: {
        url: params.callbackUrl,
        context: {
          ...context,
          _token: token,
        },
      },
    };
  });

  return [
    {
      text: params.text ?? "",
      actions,
    },
  ];
}

// ── Localhost validation ───────────────────────────────────────────────

const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLocalhostRequest(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress;
  if (!addr) {
    return false;
  }
  return LOCALHOST_ADDRESSES.has(addr);
}

// ── Request body reader ────────────────────────────────────────────────

function readInteractionBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("Request body read timeout"));
    }, INTERACTION_BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > INTERACTION_MAX_BODY_BYTES) {
        req.destroy();
        clearTimeout(timer);
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── HTTP handler ───────────────────────────────────────────────────────

export function createMattermostInteractionHandler(params: {
  client: MattermostClient;
  botUserId: string;
  accountId: string;
  callbackUrl: string;
  resolveSessionKey?: (channelId: string) => Promise<string>;
  dispatchButtonClick?: (opts: {
    channelId: string;
    userId: string;
    userName: string;
    actionId: string;
    actionName: string;
    postId: string;
  }) => Promise<void>;
  log?: (message: string) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { client, botUserId, accountId, log } = params;
  const core = getMattermostRuntime();

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    // Verify request is from localhost
    if (!isLocalhostRequest(req)) {
      log?.(
        `mattermost interaction: rejected non-localhost request from ${req.socket?.remoteAddress}`,
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    let payload: MattermostInteractionPayload;
    try {
      const raw = await readInteractionBody(req);
      payload = JSON.parse(raw) as MattermostInteractionPayload;
    } catch (err) {
      log?.(`mattermost interaction: failed to parse body: ${String(err)}`);
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const context = payload.context;
    if (!context) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing context" }));
      return;
    }

    // Verify HMAC token
    const token = context._token;
    if (typeof token !== "string") {
      log?.("mattermost interaction: missing _token in context");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing token" }));
      return;
    }

    // Strip _token before verification (it wasn't in the original context)
    const { _token, ...contextWithoutToken } = context;
    if (!verifyInteractionToken(contextWithoutToken, token)) {
      log?.("mattermost interaction: invalid _token");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    const actionId = context.action_id;
    if (typeof actionId !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing action_id in context" }));
      return;
    }

    log?.(
      `mattermost interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} ` +
        `post=${payload.post_id} channel=${payload.channel_id}`,
    );

    // Dispatch as system event so the agent can handle it.
    // Wrapped in try/catch — the post update below must still run even if
    // system event dispatch fails (e.g. missing sessionKey or channel lookup).
    try {
      const eventLabel =
        `Mattermost button click: action="${actionId}" ` +
        `by ${payload.user_name ?? payload.user_id} ` +
        `in channel ${payload.channel_id}`;

      const sessionKey = params.resolveSessionKey
        ? await params.resolveSessionKey(payload.channel_id)
        : `agent:main:mattermost:${accountId}:${payload.channel_id}`;

      core.system.enqueueSystemEvent(eventLabel, {
        sessionKey,
        contextKey: `mattermost:interaction:${payload.post_id}:${actionId}`,
      });
    } catch (err) {
      log?.(`mattermost interaction: system event dispatch failed: ${String(err)}`);
    }

    // Fetch the original post to preserve its message and find the clicked button name.
    const userName = payload.user_name ?? payload.user_id;
    let originalMessage = "";
    let clickedButtonName = actionId; // fallback to action ID if we can't find the name
    try {
      const originalPost = await client.request<{
        message?: string;
        props?: Record<string, unknown>;
      }>(`/posts/${payload.post_id}`);
      originalMessage = originalPost?.message ?? "";

      // Find the clicked button's display name from the original attachments
      const postAttachments = Array.isArray(originalPost?.props?.attachments)
        ? (originalPost.props.attachments as Array<{
            actions?: Array<{ id?: string; name?: string }>;
          }>)
        : [];
      for (const att of postAttachments) {
        const match = att.actions?.find((a) => a.id === actionId);
        if (match?.name) {
          clickedButtonName = match.name;
          break;
        }
      }
    } catch (err) {
      log?.(`mattermost interaction: failed to fetch post ${payload.post_id}: ${String(err)}`);
    }

    // Update the post via API to replace buttons with a completion indicator.
    try {
      await updateMattermostPost(client, payload.post_id, {
        message: originalMessage,
        props: {
          attachments: [
            {
              text: `✓ **${clickedButtonName}** selected by @${userName}`,
            },
          ],
        },
      });
    } catch (err) {
      log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(err)}`);
    }

    // Respond with empty JSON — the post update is handled above
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");

    // Dispatch a synthetic inbound message so the agent responds to the button click.
    if (params.dispatchButtonClick) {
      try {
        await params.dispatchButtonClick({
          channelId: payload.channel_id,
          userId: payload.user_id,
          userName,
          actionId,
          actionName: clickedButtonName,
          postId: payload.post_id,
        });
      } catch (err) {
        log?.(`mattermost interaction: dispatchButtonClick failed: ${String(err)}`);
      }
    }
  };
}
