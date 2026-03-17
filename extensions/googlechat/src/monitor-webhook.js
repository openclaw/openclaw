import {
  readJsonWebhookBodyOrReject,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline
} from "openclaw/plugin-sdk/googlechat";
import { verifyGoogleChatRequest } from "./auth.js";
function extractBearerToken(header) {
  const authHeader = Array.isArray(header) ? String(header[0] ?? "") : String(header ?? "");
  return authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice("bearer ".length).trim() : "";
}
function parseGoogleChatInboundPayload(raw, res) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }
  let eventPayload = raw;
  let addOnBearerToken = "";
  const rawObj = raw;
  if (rawObj.commonEventObject?.hostApp === "CHAT" && rawObj.chat?.messagePayload) {
    const chat = rawObj.chat;
    const messagePayload = chat.messagePayload;
    eventPayload = {
      type: "MESSAGE",
      space: messagePayload?.space,
      message: messagePayload?.message,
      user: chat.user,
      eventTime: chat.eventTime
    };
    addOnBearerToken = String(rawObj.authorizationEventObject?.systemIdToken ?? "").trim();
  }
  const event = eventPayload;
  const eventType = event.type ?? eventPayload.eventType;
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
function createGoogleChatWebhookRequestHandler(params) {
  return async (req, res) => {
    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: params.webhookTargets,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      inFlightLimiter: params.webhookInFlightLimiter,
      handle: async ({ targets }) => {
        const headerBearer = extractBearerToken(req.headers.authorization);
        let selectedTarget = null;
        let parsedEvent = null;
        const readAndParseEvent = async (profile) => {
          const body = await readJsonWebhookBodyOrReject({
            req,
            res,
            profile,
            emptyObjectOnEmpty: false,
            invalidJsonMessage: "invalid payload"
          });
          if (!body.ok) {
            return null;
          }
          const parsed = parseGoogleChatInboundPayload(body.value, res);
          return parsed.ok ? parsed : null;
        };
        if (headerBearer) {
          selectedTarget = await resolveWebhookTargetWithAuthOrReject({
            targets,
            res,
            isMatch: async (target) => {
              const verification = await verifyGoogleChatRequest({
                bearer: headerBearer,
                audienceType: target.audienceType,
                audience: target.audience
              });
              return verification.ok;
            }
          });
          if (!selectedTarget) {
            return true;
          }
          const parsed = await readAndParseEvent("post-auth");
          if (!parsed) {
            return true;
          }
          parsedEvent = parsed.event;
        } else {
          const parsed = await readAndParseEvent("pre-auth");
          if (!parsed) {
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
                audience: target.audience
              });
              return verification.ok;
            }
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
            `[${dispatchTarget.account.accountId}] Google Chat webhook failed: ${String(err)}`
          );
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
        return true;
      }
    });
  };
}
export {
  createGoogleChatWebhookRequestHandler
};
