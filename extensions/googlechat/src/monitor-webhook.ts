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
    console.error("[googlechat/webhook] invalid payload (not an object):", JSON.stringify(raw));
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
      spacePayload?: { space?: GoogleChatSpace };
      spacesPayload?: { space?: GoogleChatSpace }; // some cases have this
      user?: GoogleChatUser;
      eventTime?: string;
      type?: string;
    };
    authorizationEventObject?: { systemIdToken?: string };
  };

  if (rawObj.commonEventObject?.hostApp === "CHAT") {
    // It's a GSuite Add-on payload for Chat
    addOnBearerToken = String(rawObj.authorizationEventObject?.systemIdToken ?? "").trim();

    // Convert to standard Chat API format based on what's available
    const chat = rawObj.chat;
    if (chat) {
      const space =
        chat.messagePayload?.space ||
        chat.spacesPayload?.space ||
        chat.spacePayload?.space ||
        (chat as any).space;
      const message = chat.messagePayload?.message || (chat as any).message;
      const eventType =
        chat.type || (chat as any).eventType || (message ? "MESSAGE" : "ADDED_TO_SPACE");

      eventPayload = {
        type: eventType,
        space: space,
        message: message,
        user: chat.user,
        eventTime: chat.eventTime,
      };
      console.log(
        `[googlechat/webhook] Transformed Add-on payload to Chat API event type=${eventType}`,
      );
    } else {
      console.log("[googlechat/webhook] Add-on payload missing chat object");
    }
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? (eventPayload as { eventType?: string }).eventType;
  if (typeof eventType !== "string") {
    console.error(
      `[googlechat/webhook] invalid payload (no event type): ${JSON.stringify(raw).slice(0, 500)}`,
    );
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (!event.space || typeof event.space !== "object" || Array.isArray(event.space)) {
    console.error(
      `[googlechat/webhook] invalid payload (no space object): type=${eventType} payload=${JSON.stringify(raw).slice(0, 500)}`,
    );
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (eventType === "MESSAGE") {
    if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
      console.error(
        `[googlechat/webhook] invalid payload (MESSAGE event has no message object): ${JSON.stringify(raw).slice(0, 500)}`,
      );
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
