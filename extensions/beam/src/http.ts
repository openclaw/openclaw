import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJsonNoStore as sendJson } from "openclaw/plugin-sdk/http-response-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { buildControlUiCatalogSharePath } from "openclaw/plugin-sdk/session-catalog-runtime";
import {
  beginWebhookRequestPipelineOrReject,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { BeamPublisher } from "../upload-operation-api.js";
import type { BeamStore } from "./store.js";
import { BEAM_MAX_BODY_BYTES, BEAM_SESSION_SHARE_ROUTE, parseBeamUpload } from "./types.js";

type BeamRequestClient = {
  clientIp: string;
  scopes: readonly string[];
  profileId?: string;
  visitorGrant?: { assertCurrent(): void };
};

function currentRequestClient(req: IncomingMessage): BeamRequestClient {
  const client = getPluginRuntimeGatewayRequestScope()?.client;
  const access = client?.internal?.operatorAccessAuthority;
  return {
    clientIp: client?.clientIp ?? req.socket.remoteAddress ?? "unknown",
    scopes: client?.connect?.scopes ?? [],
    profileId: client?.authenticatedUserProfile?.profileId,
    ...(access?.requiredPolicyPlugin === "visitor-access" &&
    access.gatewayAccessGrant?.pluginId === "visitor-access"
      ? { visitorGrant: access }
      : {}),
  };
}

function canPublish(scopes: readonly string[]): boolean {
  return scopes.includes("operator.write") || scopes.includes("operator.admin");
}

export function createBeamRequestHandler(params: {
  store: BeamStore;
  now?: () => number;
  resolveClient?: (req: IncomingMessage) => BeamRequestClient;
  resolveControlUiBasePath: () => string | undefined;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const rateLimiter = createFixedWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    maxTrackedKeys: 2_048,
  });
  const inFlightLimiter = createWebhookInFlightLimiter({
    maxInFlightPerKey: 2,
    maxTrackedKeys: 2_048,
  });

  return async (req, res) => {
    const scope = getPluginRuntimeGatewayRequestScope();
    const client = params.resolveClient?.(req) ?? currentRequestClient(req);
    const publisher: BeamPublisher | undefined = canPublish(client.scopes)
      ? { kind: "staff", profileId: client.profileId }
      : client.scopes.includes("operator.sessions.write") && client.profileId && client.visitorGrant
        ? { kind: "guest", profileId: client.profileId }
        : undefined;
    if (!publisher) {
      sendJson(res, 403, {
        ok: false,
        error: "Beam requires operator.write or an active verified Visitor publisher",
      });
      return true;
    }
    const assertCurrent = () => {
      if (
        scope?.signal?.aborted ||
        scope?.hasCurrentClientAuthority?.() === false ||
        res.writableEnded ||
        res.destroyed
      ) {
        if (!res.writableEnded && !res.destroyed) {
          sendJson(res, 401, { ok: false, error: "Beam publisher authority expired" });
        }
        throw new Error("Beam publisher authority expired");
      }
      client.visitorGrant?.assertCurrent();
    };
    assertCurrent();
    const pipeline = beginWebhookRequestPipelineOrReject({
      req,
      res,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      rateLimiter,
      rateLimitKey: client.clientIp,
      inFlightLimiter,
      inFlightKey: client.clientIp,
    });
    if (!pipeline.ok) {
      return true;
    }

    try {
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: BEAM_MAX_BODY_BYTES,
        timeoutMs: 10_000,
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "invalid Beam request body",
      });
      if (!body.ok) {
        return true;
      }
      const parsed = parseBeamUpload(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      await scope?.revalidate?.();
      assertCurrent();
      const receivedAt = params.now?.() ?? Date.now();
      const result = await params.store.upload(parsed.value, {
        receivedAt,
        publisher,
        assertCurrent,
      });
      assertCurrent();
      if (result === "forbidden") {
        sendJson(res, 403, {
          ok: false,
          error:
            "Beam is not owned by this publisher. Publish a new source session (new Beam ID) or ask a Gateway operator whether the retained snapshot can be removed.",
        });
        return true;
      }
      if (result === "publisher-full" || result === "catalog-full") {
        sendJson(res, 429, {
          ok: false,
          error:
            result === "publisher-full"
              ? "Beam publisher limit reached (20 live snapshots); refresh an existing Beam or wait for expiry"
              : "Beam catalog is full; refresh an existing Beam or ask a Gateway operator to free space",
        });
        return true;
      }
      if (result === "handoff-conflict") {
        sendJson(res, 409, {
          ok: false,
          error:
            "This source snapshot cannot establish a handoff. Reconcile the current Beam publication before releasing it; no destination was created.",
        });
        return true;
      }
      const handoff = typeof result === "object" && result.kind === "handoff" ? result : undefined;
      sendJson(res, handoff?.accepted === false ? 409 : 200, {
        ...(publisher.kind === "guest" ? { canView: true } : {}),
        ok: handoff?.accepted !== false,
        ...(typeof result === "object" && result.kind === "published" && result.id
          ? { publicationId: result.id }
          : {}),
        ...(handoff
          ? {
              handoff: {
                id: handoff.id,
                owner: "gateway",
                access: publisher.kind === "guest" ? "owned" : "shared",
              },
              ...(handoff.accepted
                ? {}
                : {
                    error:
                      "This conversation moved to Team. The local snapshot was not accepted; continue through the Beam client's read/continue commands or the returned link.",
                  }),
            }
          : {}),
        beamId: parsed.value.beamId,
        url: buildControlUiCatalogSharePath({
          shareRoute: BEAM_SESSION_SHARE_ROUTE,
          threadId: parsed.value.beamId,
          displayName: parsed.value.title,
          basePath: params.resolveControlUiBasePath(),
        }),
      });
      return true;
    } finally {
      pipeline.release();
    }
  };
}
