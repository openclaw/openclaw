import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeWebhookPath,
  readJsonWebhookBodyOrReject,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { CampfireWebhookPayload } from "../types.js";
import { parseCampfirePayload } from "./payload.js";

type CampfireWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type CampfireInboundHandler = (payload: CampfireWebhookPayload) => Promise<void> | void;

const activeCampfireWebhookPathReservations = new Map<
  string,
  {
    accountId: string;
    tokens: Set<symbol>;
  }
>();

function reserveCampfireWebhookPath(params: { accountId: string; path: string }): () => void {
  const reservationPath = normalizeWebhookPath(params.path);
  const existing = activeCampfireWebhookPathReservations.get(reservationPath);
  if (existing && existing.accountId !== params.accountId) {
    throw new Error(
      `Campfire webhook path "${reservationPath}" is already assigned to account "${existing.accountId}"`,
    );
  }

  const token = Symbol(params.accountId);
  const reservation = existing ?? {
    accountId: params.accountId,
    tokens: new Set<symbol>(),
  };
  reservation.tokens.add(token);
  activeCampfireWebhookPathReservations.set(reservationPath, reservation);

  return () => {
    const current = activeCampfireWebhookPathReservations.get(reservationPath);
    if (!current || current.accountId !== params.accountId) {
      return;
    }
    current.tokens.delete(token);
    if (current.tokens.size === 0) {
      activeCampfireWebhookPathReservations.delete(reservationPath);
    }
  };
}

function isCampfireRouteRegistrationFailureLog(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("webhook path missing") ||
    normalized.includes("route overlap denied") ||
    normalized.includes("route conflict") ||
    normalized.includes("route replacement denied")
  );
}

function resolveRequestSecret(req: IncomingMessage): string | null {
  const headerValue = req.headers["x-webhook-secret"];
  if (typeof headerValue === "string") {
    return headerValue;
  }
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("secret");
  } catch {
    return null;
  }
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function createCampfireWebhookHandler(params: {
  webhookSecret?: string;
  onInbound: CampfireInboundHandler;
  log?: CampfireWebhookLog;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    const configuredWebhookSecret = params.webhookSecret?.trim();
    const bodyReadProfile = configuredWebhookSecret ? "post-auth" : "pre-auth";
    if (configuredWebhookSecret) {
      const secret = resolveRequestSecret(req);
      if (!secret || !secretsMatch(secret, configuredWebhookSecret)) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    const parsedBody = await readJsonWebhookBodyOrReject({
      req,
      res,
      profile: bodyReadProfile,
      invalidJsonMessage: "Bad Request",
    });
    if (!parsedBody.ok) {
      return;
    }

    const payload = parseCampfirePayload(parsedBody.value);
    if (!payload) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    res.statusCode = 200;
    res.end("OK");

    setImmediate(() => {
      void Promise.resolve(params.onInbound(payload)).catch((err) => {
        params.log?.error?.(`Campfire inbound dispatch failed: ${String(err)}`);
      });
    });
  };
}

export function registerCampfireWebhookRoute(params: {
  accountId: string;
  path?: string;
  webhookSecret?: string;
  onInbound: CampfireInboundHandler;
  log?: CampfireWebhookLog;
  registerRoute?: typeof registerPluginHttpRoute;
}): () => void {
  const path = normalizeWebhookPath(
    params.path ?? `/channels/campfire/webhook/${params.accountId}`,
  );
  const releaseReservation = reserveCampfireWebhookPath({
    accountId: params.accountId,
    path,
  });
  const registerRoute = params.registerRoute ?? registerPluginHttpRoute;
  let registrationErrorMessage: string | null = null;
  const routeLog = (message: string) => {
    if (!registrationErrorMessage && isCampfireRouteRegistrationFailureLog(message)) {
      registrationErrorMessage = message;
    }
    params.log?.info?.(message);
  };

  let unregister: (() => void) | undefined;
  try {
    unregister = registerRoute({
      path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      pluginId: "campfire",
      accountId: params.accountId,
      source: "campfire-webhook",
      log: routeLog,
      handler: createCampfireWebhookHandler({
        webhookSecret: params.webhookSecret,
        onInbound: params.onInbound,
        log: params.log,
      }),
    });
    if (registrationErrorMessage) {
      unregister?.();
      releaseReservation();
      throw new Error(registrationErrorMessage);
    }
  } catch (err) {
    releaseReservation();
    throw err;
  }

  return () => {
    unregister?.();
    releaseReservation();
  };
}

export const __testing = {
  resetCampfireWebhookPathReservations: () => {
    activeCampfireWebhookPathReservations.clear();
  },
};
