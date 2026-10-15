// Transport helpers for the GPT-Live browser offer endpoint.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  isRequestBodyLimitError,
  requestBodyErrorToText,
  resolveAcceptedBrowserOrigin,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";

export function createResponseDeliveryWaiter(res: ServerResponse, onDelivered: () => void) {
  const { promise: result, resolve } = createDeferred<boolean>();
  const settle = (delivered: boolean) => {
    res.removeListener("finish", onFinish);
    res.removeListener("close", onClose);
    resolve(delivered);
  };
  const onFinish = () => {
    onDelivered();
    settle(true);
  };
  const onClose = () => settle(false);
  res.once("finish", onFinish);
  res.once("close", onClose);
  return { result, cancel: () => settle(false) };
}

const OFFER_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * The one writer for every offer-endpoint response, error text and SDP answer
 * alike, so no caller sets the security headers by hand and forgets one.
 */
export function respondRealtimeOffer(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = OFFER_TEXT_CONTENT_TYPE,
): void {
  res.statusCode = statusCode;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

export function applyRealtimeOfferCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveAcceptedBrowserOrigin({ req, cfg });
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  return true;
}

/** Reservation for a Gateway-brokered realtime offer.
 *
 * Browser clients send the token here and leave `Authorization` unset. A
 * reverse proxy in front of the Gateway can then keep using `Authorization`
 * for HTTP basic auth. Direct provider calls still use `Authorization: Bearer`.
 */
export const REALTIME_OFFER_TOKEN_HEADER = "X-OpenClaw-Realtime-Token";

function readSingleHeaderToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  if (typeof header !== "string") {
    return undefined;
  }
  const token = header.trim();
  // One token. A comma or whitespace is a combined header, not a reservation.
  if (!token || /[\s,]/.test(token)) {
    return undefined;
  }
  return token;
}

export function readOfferBearerToken(req: IncomingMessage): string | undefined {
  const dedicated = readSingleHeaderToken(req.headers[REALTIME_OFFER_TOKEN_HEADER.toLowerCase()]);
  if (dedicated) {
    return dedicated;
  }
  const authorization = req.headers.authorization;
  const authorizationValue = Array.isArray(authorization) ? authorization[0] : authorization;
  return authorizationValue?.trim().match(/^Bearer\s+([^\s]+)$/i)?.[1];
}

/**
 * Answer an over-limit or stalled offer through the connection owner.
 *
 * The reader defers destruction for those two codes, so the connection is already fenced
 * and only the owner can still write; responding directly would race the teardown and the
 * browser would see a reset instead of the status.
 */
export async function rejectOversizedOffer(
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
): Promise<boolean> {
  if (!isRequestBodyLimitError(error)) {
    return false;
  }
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  await sendHttpRequestRejection(
    req,
    res,
    error.statusCode,
    requestBodyErrorToText(error.code),
    OFFER_TEXT_CONTENT_TYPE,
  );
  return true;
}
