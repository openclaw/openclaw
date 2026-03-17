import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isTrustedProxyAddress,
  resolveClientIp
} from "openclaw/plugin-sdk/mattermost";
import { getMattermostRuntime } from "../runtime.js";
import { updateMattermostPost } from "./client.js";
const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 1e4;
const SIGNED_CHANNEL_ID_CONTEXT_KEY = "__openclaw_channel_id";
const callbackUrls = /* @__PURE__ */ new Map();
function setInteractionCallbackUrl(accountId, url) {
  callbackUrls.set(accountId, url);
}
function getInteractionCallbackUrl(accountId) {
  return callbackUrls.get(accountId);
}
function resolveInteractionCallbackPath(accountId) {
  return `/mattermost/interactions/${accountId}`;
}
function isWildcardBindHost(rawHost) {
  const trimmed = rawHost.trim();
  if (!trimmed) return false;
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
function normalizeCallbackBaseUrl(baseUrl) {
  return baseUrl.trim().replace(/\/+$/, "");
}
function headerValue(value) {
  if (Array.isArray(value)) {
    return value[0]?.trim() || void 0;
  }
  return value?.trim() || void 0;
}
function isAllowedInteractionSource(params) {
  const { allowedSourceIps } = params;
  if (!allowedSourceIps?.length) {
    return true;
  }
  const clientIp = resolveClientIp({
    remoteAddr: params.req.socket?.remoteAddress,
    forwardedFor: headerValue(params.req.headers["x-forwarded-for"]),
    realIp: headerValue(params.req.headers["x-real-ip"]),
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback
  });
  return isTrustedProxyAddress(clientIp, allowedSourceIps);
}
function computeInteractionCallbackUrl(accountId, cfg) {
  const path = resolveInteractionCallbackPath(accountId);
  const callbackBaseUrl = cfg?.interactions?.callbackBaseUrl?.trim() ?? cfg?.channels?.mattermost?.interactions?.callbackBaseUrl?.trim();
  if (callbackBaseUrl) {
    return `${normalizeCallbackBaseUrl(callbackBaseUrl)}${path}`;
  }
  const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
  let host = cfg?.gateway?.customBindHost && !isWildcardBindHost(cfg.gateway.customBindHost) ? cfg.gateway.customBindHost.trim() : "localhost";
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }
  return `http://${host}:${port}${path}`;
}
function resolveInteractionCallbackUrl(accountId, cfg) {
  const cached = callbackUrls.get(accountId);
  if (cached) {
    return cached;
  }
  return computeInteractionCallbackUrl(accountId, cfg);
}
const interactionSecrets = /* @__PURE__ */ new Map();
let defaultInteractionSecret;
function deriveInteractionSecret(botToken) {
  return createHmac("sha256", "openclaw-mattermost-interactions").update(botToken).digest("hex");
}
function setInteractionSecret(accountIdOrBotToken, botToken) {
  if (typeof botToken === "string") {
    interactionSecrets.set(accountIdOrBotToken, deriveInteractionSecret(botToken));
    return;
  }
  defaultInteractionSecret = deriveInteractionSecret(accountIdOrBotToken);
}
function getInteractionSecret(accountId) {
  const scoped = accountId ? interactionSecrets.get(accountId) : void 0;
  if (scoped) {
    return scoped;
  }
  if (defaultInteractionSecret) {
    return defaultInteractionSecret;
  }
  if (interactionSecrets.size === 1) {
    const first = interactionSecrets.values().next().value;
    if (typeof first === "string") {
      return first;
    }
  }
  throw new Error(
    "Interaction secret not initialized \u2014 call setInteractionSecret(accountId, botToken) first"
  );
}
function canonicalizeInteractionContext(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeInteractionContext(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, entryValue]) => [key, canonicalizeInteractionContext(entryValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}
function generateInteractionToken(context, accountId) {
  const secret = getInteractionSecret(accountId);
  const payload = JSON.stringify(canonicalizeInteractionContext(context));
  return createHmac("sha256", secret).update(payload).digest("hex");
}
function verifyInteractionToken(context, token, accountId) {
  const expected = generateInteractionToken(context, accountId);
  if (expected.length !== token.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
function sanitizeActionId(id) {
  return id.replace(/[-_]/g, "");
}
function buildButtonAttachments(params) {
  const actions = params.buttons.map((btn) => {
    const safeId = sanitizeActionId(btn.id);
    const context = {
      action_id: safeId,
      ...btn.context
    };
    const token = generateInteractionToken(context, params.accountId);
    return {
      id: safeId,
      type: "button",
      name: btn.name,
      style: btn.style,
      integration: {
        url: params.callbackUrl,
        context: {
          ...context,
          _token: token
        }
      }
    };
  });
  return [
    {
      text: params.text ?? "",
      actions
    }
  ];
}
function buildButtonProps(params) {
  const rawButtons = params.buttons.flatMap(
    (item) => Array.isArray(item) ? item : [item]
  );
  const buttons = rawButtons.map((btn) => ({
    id: String(btn.id ?? btn.callback_data ?? "").trim(),
    name: String(btn.text ?? btn.name ?? btn.label ?? "").trim(),
    style: btn.style ?? "default",
    context: typeof btn.context === "object" && btn.context !== null ? {
      ...btn.context,
      [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId
    } : { [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId }
  })).filter((btn) => btn.id && btn.name);
  if (buttons.length === 0) {
    return void 0;
  }
  return {
    attachments: buildButtonAttachments({
      callbackUrl: params.callbackUrl,
      accountId: params.accountId,
      buttons,
      text: params.text
    })
  };
}
function readInteractionBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("Request body read timeout"));
    }, INTERACTION_BODY_TIMEOUT_MS);
    req.on("data", (chunk) => {
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
function createMattermostInteractionHandler(params) {
  const { client, accountId, log } = params;
  const core = getMattermostRuntime();
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }
    if (!isAllowedInteractionSource({
      req,
      allowedSourceIps: params.allowedSourceIps,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback
    })) {
      log?.(
        `mattermost interaction: rejected callback source remote=${req.socket?.remoteAddress ?? "?"}`
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    let payload;
    try {
      const raw = await readInteractionBody(req);
      payload = JSON.parse(raw);
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
    const token = context._token;
    if (typeof token !== "string") {
      log?.("mattermost interaction: missing _token in context");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing token" }));
      return;
    }
    const { _token, ...contextWithoutToken } = context;
    if (!verifyInteractionToken(contextWithoutToken, token, accountId)) {
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
    const signedChannelId = typeof contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY] === "string" ? contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY].trim() : "";
    if (signedChannelId && signedChannelId !== payload.channel_id) {
      log?.(
        `mattermost interaction: signed channel mismatch payload=${payload.channel_id} signed=${signedChannelId}`
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Channel mismatch" }));
      return;
    }
    const userName = payload.user_name ?? payload.user_id;
    let originalMessage = "";
    let originalPost = null;
    let clickedButtonName = null;
    try {
      originalPost = await client.request(`/posts/${payload.post_id}`);
      const postChannelId = originalPost.channel_id?.trim();
      if (!postChannelId || postChannelId !== payload.channel_id) {
        log?.(
          `mattermost interaction: post channel mismatch payload=${payload.channel_id} post=${postChannelId ?? "<missing>"}`
        );
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Post/channel mismatch" }));
        return;
      }
      originalMessage = originalPost.message ?? "";
      const postAttachments = Array.isArray(originalPost?.props?.attachments) ? originalPost.props.attachments : [];
      for (const att of postAttachments) {
        const match = att.actions?.find((a) => a.id === actionId);
        if (match?.name) {
          clickedButtonName = match.name;
          break;
        }
      }
      if (clickedButtonName === null) {
        log?.(`mattermost interaction: action ${actionId} not found in post ${payload.post_id}`);
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Unknown action" }));
        return;
      }
    } catch (err) {
      log?.(`mattermost interaction: failed to validate post ${payload.post_id}: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Failed to validate interaction" }));
      return;
    }
    if (!originalPost) {
      log?.(`mattermost interaction: missing fetched post ${payload.post_id}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Failed to load interaction post" }));
      return;
    }
    log?.(
      `mattermost interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} post=${payload.post_id} channel=${payload.channel_id}`
    );
    if (params.handleInteraction) {
      try {
        const response = await params.handleInteraction({
          payload,
          userName,
          actionId,
          actionName: clickedButtonName,
          originalMessage,
          context: contextWithoutToken,
          post: originalPost
        });
        if (response !== null) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
          return;
        }
      } catch (err) {
        log?.(`mattermost interaction: custom handler failed: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction handler failed" }));
        return;
      }
    }
    try {
      const eventLabel = `Mattermost button click: action="${actionId}" by ${payload.user_name ?? payload.user_id} in channel ${payload.channel_id}`;
      const sessionKey = params.resolveSessionKey ? await params.resolveSessionKey({
        channelId: payload.channel_id,
        userId: payload.user_id,
        post: originalPost
      }) : `agent:main:mattermost:${accountId}:${payload.channel_id}`;
      core.system.enqueueSystemEvent(eventLabel, {
        sessionKey,
        contextKey: `mattermost:interaction:${payload.post_id}:${actionId}`
      });
    } catch (err) {
      log?.(`mattermost interaction: system event dispatch failed: ${String(err)}`);
    }
    try {
      await updateMattermostPost(client, payload.post_id, {
        message: originalMessage,
        props: {
          attachments: [
            {
              text: `\u2713 **${clickedButtonName}** selected by @${userName}`
            }
          ]
        }
      });
    } catch (err) {
      log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(err)}`);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
    if (params.dispatchButtonClick) {
      try {
        await params.dispatchButtonClick({
          channelId: payload.channel_id,
          userId: payload.user_id,
          userName,
          actionId,
          actionName: clickedButtonName,
          postId: payload.post_id,
          post: originalPost
        });
      } catch (err) {
        log?.(`mattermost interaction: dispatchButtonClick failed: ${String(err)}`);
      }
    }
  };
}
export {
  buildButtonAttachments,
  buildButtonProps,
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  generateInteractionToken,
  getInteractionCallbackUrl,
  getInteractionSecret,
  resolveInteractionCallbackPath,
  resolveInteractionCallbackUrl,
  setInteractionCallbackUrl,
  setInteractionSecret,
  verifyInteractionToken
};
