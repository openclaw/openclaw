import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-request-guards";
import { readJsonWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "openclaw/plugin-sdk/webhook-targets";
import { verifyGoogleChatRequest } from "./auth.js";
import type { WebhookTarget } from "./monitor-types.js";
import type {
  GoogleChatEvent,
  GoogleChatMessage,
  GoogleChatSpace,
  GoogleChatUser,
} from "./types.js";

function extractBearerToken(header: unknown): string {
  const authHeader = Array.isArray(header)
    ? typeof header[0] === "string"
      ? header[0]
      : ""
    : typeof header === "string"
      ? header
      : "";
  return normalizeLowercaseStringOrEmpty(authHeader).startsWith("bearer ")
    ? authHeader.slice("bearer ".length).trim()
    : "";
}

const ADD_ON_PREAUTH_MAX_BYTES = 16 * 1024;
const ADD_ON_PREAUTH_TIMEOUT_MS = 3_000;

type ParsedGoogleChatInboundPayload =
  | { ok: true; event: GoogleChatEvent; addOnBearerToken: string }
  | { ok: false };
type ParsedGoogleChatInboundSuccess = Extract<ParsedGoogleChatInboundPayload, { ok: true }>;

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
  //
  // The add-on framework wraps the chat event inside `rawObj.chat.<eventKind>Payload`
  // (per https://developers.google.com/workspace/add-ons/chat/event-objects) and does
  // NOT include a top-level `type` field. The event kind must be inferred from which
  // `chat.*Payload` is populated. Prior to this fix, the code only handled
  // `messagePayload` and hardcoded `type: "MESSAGE"`, which:
  //   1) Dropped non-MESSAGE event kinds (ADDED_TO_SPACE, REMOVED_FROM_SPACE,
  //      APP_COMMAND, etc.) — they hit the eventType-is-string guard below and 400'd.
  //   2) For non-MESSAGE kinds that did slip through (because we still set
  //      type=MESSAGE), the downstream `event.message` validation would 400 since
  //      e.g. addedToSpacePayload has no `message` field.
  // Reports: openclaw/openclaw#13856 (space events not received), #35095, #57386.
  const rawObj = raw as {
    type?: string;
    eventTime?: string;
    commonEventObject?: { hostApp?: string };
    chat?: {
      messagePayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      addedToSpacePayload?: { space?: GoogleChatSpace };
      removedFromSpacePayload?: { space?: GoogleChatSpace };
      appCommandPayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      buttonClickedPayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      cardClickedPayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      user?: GoogleChatUser;
      eventTime?: string;
    };
    authorizationEventObject?: { systemIdToken?: string };
  };

  if (rawObj.commonEventObject?.hostApp === "CHAT" && rawObj.chat) {
    const chat = rawObj.chat;
    let payload:
      | { space?: GoogleChatSpace; message?: GoogleChatMessage }
      | undefined;
    let derivedType: string | undefined;
    if (chat.messagePayload) {
      payload = chat.messagePayload;
      derivedType = "MESSAGE";
    } else if (chat.addedToSpacePayload) {
      payload = chat.addedToSpacePayload;
      derivedType = "ADDED_TO_SPACE";
    } else if (chat.removedFromSpacePayload) {
      payload = chat.removedFromSpacePayload;
      derivedType = "REMOVED_FROM_SPACE";
    } else if (chat.appCommandPayload) {
      payload = chat.appCommandPayload;
      derivedType = "APP_COMMAND";
    } else if (chat.buttonClickedPayload) {
      payload = chat.buttonClickedPayload;
      derivedType = "CARD_CLICKED";
    } else if (chat.cardClickedPayload) {
      payload = chat.cardClickedPayload;
      derivedType = "CARD_CLICKED";
    }
    if (payload) {
      eventPayload = {
        type: typeof rawObj.type === "string" ? rawObj.type : derivedType,
        space: payload.space,
        message: payload.message,
        user: chat.user,
        eventTime: chat.eventTime ?? rawObj.eventTime,
      };
    }
    addOnBearerToken =
      typeof rawObj.authorizationEventObject?.systemIdToken === "string"
        ? rawObj.authorizationEventObject.systemIdToken.trim()
        : "";
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? (eventPayload as { eventType?: string }).eventType;
  if (typeof eventType !== "string") {
    // Diagnostic — silent 400s are how this bug stayed in production unnoticed.
    // Operators have to grep journalctl/stderr to discover why Google's framework
    // got HTTP 400 from our endpoint; structured log makes that obvious.
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[googlechat] parseGoogleChatInboundPayload 400 eventType-missing ${JSON.stringify({
          rootKeys: Object.keys(rawObj),
          hasChat: Boolean(rawObj.chat),
          chatKeys: rawObj.chat ? Object.keys(rawObj.chat) : null,
          hostApp: rawObj.commonEventObject?.hostApp,
        })}`,
      );
    } catch {
      /* logging best-effort */
    }
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (!event.space || typeof event.space !== "object" || Array.isArray(event.space)) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[googlechat] parseGoogleChatInboundPayload 400 space-missing ${JSON.stringify({
          eventType,
          rootKeys: Object.keys(rawObj),
          hasChat: Boolean(rawObj.chat),
          chatKeys: rawObj.chat ? Object.keys(rawObj.chat) : null,
        })}`,
      );
    } catch {
      /* logging best-effort */
    }
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (eventType === "MESSAGE") {
    if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[googlechat] parseGoogleChatInboundPayload 400 message-missing ${JSON.stringify({
            rootKeys: Object.keys(rawObj),
            hasChat: Boolean(rawObj.chat),
            chatKeys: rawObj.chat ? Object.keys(rawObj.chat) : null,
          })}`,
        );
      } catch {
        /* logging best-effort */
      }
      res.statusCode = 400;
      res.end("invalid payload");
      return { ok: false };
    }
  }

  return { ok: true, event, addOnBearerToken };
}

type GoogleChatWebhookAuthRejection = {
  target: WebhookTarget;
  reason: string;
};

async function verifyGoogleChatTargetAuth(
  target: WebhookTarget,
  bearer: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verification = await verifyGoogleChatRequest({
    bearer,
    audienceType: target.audienceType,
    audience: target.audience,
    expectedAddOnPrincipal: target.account.config.appPrincipal,
  });
  return verification.ok ? { ok: true } : { ok: false, reason: verification.reason ?? "unknown" };
}

function logGoogleChatWebhookAuthRejections(rejections: GoogleChatWebhookAuthRejection[]): void {
  for (const rejection of rejections) {
    rejection.target.runtime.log?.(
      `[${rejection.target.account.accountId}] Google Chat webhook auth rejected: ${rejection.reason}`,
    );
  }
}

function logGoogleChatWebhookAuthRejectedForTargets(
  targets: readonly WebhookTarget[],
  reason: string,
): void {
  logGoogleChatWebhookAuthRejections(targets.map((target) => ({ target, reason })));
}

async function resolveGoogleChatWebhookTargetWithAuthOrReject(params: {
  targets: readonly WebhookTarget[];
  res: ServerResponse;
  bearer: string;
}): Promise<WebhookTarget | null> {
  const rejections: GoogleChatWebhookAuthRejection[] = [];
  let verifiedTargetCount = 0;
  const selectedTarget = await resolveWebhookTargetWithAuthOrReject({
    targets: params.targets,
    res: params.res,
    isMatch: async (target) => {
      const verification = await verifyGoogleChatTargetAuth(target, params.bearer);
      if (verification.ok) {
        verifiedTargetCount += 1;
        return true;
      }
      rejections.push({ target, reason: verification.reason });
      return false;
    },
  });
  if (!selectedTarget && verifiedTargetCount === 0) {
    logGoogleChatWebhookAuthRejections(rejections);
  }
  return selectedTarget;
}

export function warnAppPrincipalMisconfiguration(params: {
  accountId: string;
  audienceType?: string;
  appPrincipal?: string | null;
  log?: (message: string) => void;
}): void {
  if (params.audienceType !== "app-url") {
    return;
  }
  const principal = params.appPrincipal?.trim();
  if (!principal) {
    params.log?.(
      `[${params.accountId}] appPrincipal is missing for audienceType "app-url"; add-on token verification will fail. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.`,
    );
  } else if (principal.includes("@")) {
    params.log?.(
      `[${params.accountId}] appPrincipal "${principal}" looks like an email address. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.`,
    );
  }
}

export function createGoogleChatWebhookRequestHandler(params: {
  webhookTargets: Map<string, WebhookTarget[]>;
  webhookInFlightLimiter: WebhookInFlightLimiter;
  processEvent: (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: params.webhookTargets,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      inFlightLimiter: params.webhookInFlightLimiter,
      handle: async ({ targets }) => {
        const headerBearer = extractBearerToken(req.headers.authorization);
        let selectedTarget: WebhookTarget | null = null;
        let parsedEvent: GoogleChatEvent | null = null;
        const readAndParseEvent = async (
          profile: "pre-auth" | "post-auth",
        ): Promise<ParsedGoogleChatInboundSuccess | null> => {
          const body = await readJsonWebhookBodyOrReject({
            req,
            res,
            profile,
            ...(profile === "pre-auth"
              ? {
                  maxBytes: ADD_ON_PREAUTH_MAX_BYTES,
                  timeoutMs: ADD_ON_PREAUTH_TIMEOUT_MS,
                }
              : {}),
            emptyObjectOnEmpty: false,
            invalidJsonMessage: "invalid payload",
          });
          if (!body.ok) {
            return null;
          }

          const parsed = parseGoogleChatInboundPayload(body.value, res);
          return parsed.ok ? parsed : null;
        };

        if (headerBearer) {
          selectedTarget = await resolveGoogleChatWebhookTargetWithAuthOrReject({
            targets,
            res,
            bearer: headerBearer,
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
            logGoogleChatWebhookAuthRejectedForTargets(targets, "missing token");
            res.statusCode = 401;
            res.end("unauthorized");
            return true;
          }

          selectedTarget = await resolveGoogleChatWebhookTargetWithAuthOrReject({
            targets,
            res,
            bearer: parsed.addOnBearerToken,
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
      },
    });
  };
}
