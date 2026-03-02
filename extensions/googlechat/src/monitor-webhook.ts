import type { IncomingMessage, ServerResponse } from "node:http";
import {
  beginWebhookRequestPipelineOrReject,
  readJsonWebhookBodyOrReject,
  resolveWebhookTargetWithAuthOrReject,
  resolveWebhookTargets,
  type WebhookInFlightLimiter,
} from "openclaw/plugin-sdk";
import { verifyGoogleChatRequest } from "./auth.js";
import type { WebhookTarget } from "./monitor-types.js";
import type {
  GoogleChatEvent,
  GoogleChatMessage,
  GoogleChatSpace,
  GoogleChatUser,
} from "./types.js";

function extractBearerToken(header: unknown): string {
  const authHeader = Array.isArray(header) ? String(header[0] ?? "") : String(header ?? "");
  return authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice("bearer ".length).trim()
    : "";
}

type ParsedGoogleChatInboundPayload =
  | { ok: true; event: GoogleChatEvent; addOnBearerToken: string }
  | { ok: false };

function parseGoogleChatInboundPayload(
  raw: unknown,
  res: ServerResponse,
): ParsedGoogleChatInboundPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  let eventPayload = raw;
  let addOnBearerToken = "";

  // Transform Google Workspace Add-on format to standard Chat API format.
  const rawObj = raw as {
    commonEventObject?: { hostApp?: string };
    chat?: {
      messagePayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      user?: GoogleChatUser;
      eventTime?: string;
    };
    authorizationEventObject?: { systemIdToken?: string };
  };

  if (rawObj.commonEventObject?.hostApp === "CHAT" && rawObj.chat?.messagePayload) {
    const chat = rawObj.chat;
    const messagePayload = chat.messagePayload;
    eventPayload = {
      type: "MESSAGE",
      space: messagePayload?.space,
      message: messagePayload?.message,
      user: chat.user,
      eventTime: chat.eventTime,
    };
    addOnBearerToken = String(rawObj.authorizationEventObject?.systemIdToken ?? "").trim();
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? (eventPayload as { eventType?: string }).eventType;
  if (typeof eventType !== "string") {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (!event.space || typeof event.space !== "object" || Array.isArray(event.space)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (eventType === "MESSAGE") {
    if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
      res.statusCode = 400;
      res.end("invalid payload");
      return { ok: false };
    }
  }

  return { ok: true, event, addOnBearerToken };
}

export function createGoogleChatWebhookRequestHandler(params: {
  webhookTargets: Map<string, WebhookTarget[]>;
  webhookInFlightLimiter: WebhookInFlightLimiter;
  processEvent: (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const resolved = resolveWebhookTargets(req, params.webhookTargets);
    if (!resolved) {
      return false;
    }
    const { path, targets } = resolved;

    const requestLifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      inFlightLimiter: params.webhookInFlightLimiter,
      inFlightKey: `${path}:${req.socket?.remoteAddress ?? "unknown"}`,
    });
    if (!requestLifecycle.ok) {
      return true;
    }

    try {
      const headerBearer = extractBearerToken(req.headers.authorization);
      let selectedTarget: WebhookTarget | null = null;
      let parsedEvent: GoogleChatEvent | null = null;

      if (headerBearer) {
        selectedTarget = await resolveWebhookTargetWithAuthOrReject({
          targets,
          res,
          isMatch: async (target) => {
            const verification = await verifyGoogleChatRequest({
              bearer: headerBearer,
              audienceType: target.audienceType,
              audience: target.audience,
            });
            return verification.ok;
          },
        });
        if (!selectedTarget) {
          return true;
        }

        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          profile: "post-auth",
          emptyObjectOnEmpty: false,
          invalidJsonMessage: "invalid payload",
        });
        if (!body.ok) {
          return true;
        }

        const parsed = parseGoogleChatInboundPayload(body.value, res);
        if (!parsed.ok) {
          return true;
        }
        parsedEvent = parsed.event;
      } else {
        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          profile: "pre-auth",
          emptyObjectOnEmpty: false,
          invalidJsonMessage: "invalid payload",
        });
        if (!body.ok) {
          return true;
        }

        const parsed = parseGoogleChatInboundPayload(body.value, res);
        if (!parsed.ok) {
          return true;
        }
        parsedEvent = parsed.event;

        if (!parsed.addOnBearerToken) {
          res.statusCode = 401;
          res.end("unauthorized");
          return true;
        }

        selectedTarget = await resolveWebhookTargetWithAuthOrReject({
          targets,
          res,
          isMatch: async (target) => {
            const verification = await verifyGoogleChatRequest({
              bearer: parsed.addOnBearerToken,
              audienceType: target.audienceType,
              audience: target.audience,
            });
            return verification.ok;
          },
        });
        if (!selectedTarget) {
          return true;
        }
      }

      if (!selectedTarget || !parsedEvent) {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }

      const dispatchTarget = selectedTarget;
      dispatchTarget.statusSink?.({ lastInboundAt: Date.now() });
      params.processEvent(parsedEvent, dispatchTarget).catch((err) => {
        dispatchTarget.runtime.error?.(
          `[${dispatchTarget.account.accountId}] Google Chat webhook failed: ${String(err)}`,
        );
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
      return true;
    } finally {
      requestLifecycle.release();
    }
  };
}
