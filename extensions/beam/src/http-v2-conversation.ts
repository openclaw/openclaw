import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import { sendJsonNoStore } from "openclaw/plugin-sdk/http-response-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonContentType, readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import type { BeamContinueService } from "./continuation-v2.js";
import type { createBeamIngressLimits } from "./http.js";
import type { BeamPublication } from "./store.js";
import { BEAM_MAX_BODY_BYTES, type BeamHandoff } from "./types.js";

export async function handleBeamSendRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestId?: string;
  publication: { beamId: string; publicationGeneration: string };
  authority: GatewayRequestAuthorityV1;
  service: BeamContinueService;
  limits: ReturnType<typeof createBeamIngressLimits>;
  readPublication(beamId: string): Promise<BeamPublication>;
  canRead(row: BeamHandoff): boolean;
  canWrite: boolean;
  uuid: RegExp;
  fail: (status: number, code: string, message: string) => void;
}) {
  const { req, res, authority, publication, fail } = params;
  const hide = () => fail(404, "unavailable", "This Beam publication is unavailable.");
  const statusOnly = req.method === "GET";
  const id = statusOnly ? params.requestId : req.headers["idempotency-key"];
  if (typeof id !== "string" || !params.uuid.test(id)) {
    if (statusOnly) {
      hide();
    } else {
      fail(
        400,
        "invalid_request",
        "Use a UUID Idempotency-Key matching the instruction request ID.",
      );
    }
    return;
  }
  if (!statusOnly && !params.canWrite) {
    hide();
    return;
  }
  const ip = authority.clientIp ?? req.socket.remoteAddress ?? "unknown";
  if (!statusOnly) {
    if (!isJsonContentType(req.headers["content-type"])) {
      fail(415, "unsupported_media", "Submit a JSON continuation request.");
      return;
    }
    if (
      params.limits.rateLimiter.isRateLimited(ip) ||
      !params.limits.inFlightLimiter.tryAcquire(ip)
    ) {
      res.setHeader("Retry-After", "60");
      fail(429, "rate_limited", "Retry after the current limit window.");
      return;
    }
  }
  try {
    const found = await params.readPublication(publication.beamId);
    if (!statusOnly) {
      await authority.revalidate();
    }
    authority.assertCurrent();
    const row = found.snapshot ?? found.ownership;
    if (!row || row.publicationId !== publication.publicationGeneration || !params.canRead(row)) {
      hide();
      return;
    }
    let result;
    if (statusOnly) {
      result = await params.service.status(row, id.toLowerCase(), authority);
    } else {
      const raw = await readRequestBodyWithLimit(req, {
        maxBytes: BEAM_MAX_BODY_BYTES,
        timeoutMs: 10_000,
        destroyOnLimit: false,
        encoding: "latin1",
      });
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Buffer.from(raw, "latin1"),
          ),
        );
      } catch {
        value = undefined;
      }
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => !["requestId", "instruction", "agent"].includes(key)) ||
        typeof value.requestId !== "string" ||
        value.requestId !== id ||
        typeof value.instruction !== "string" ||
        !value.instruction.trim() ||
        !value.instruction.isWellFormed() ||
        Buffer.byteLength(value.instruction) > 48 * 1024 ||
        (value.agent !== undefined &&
          (typeof value.agent !== "string" || !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(value.agent)))
      ) {
        fail(
          400,
          "invalid_request",
          "Provide a matching request ID, a nonempty instruction up to 48 KiB, and an optional agent ID.",
        );
        return;
      }
      await authority.revalidate();
      authority.assertCurrent();
      result = await params.service.continue(
        row,
        {
          requestId: id.toLowerCase(),
          instruction: value.instruction,
          ...(value.agent ? { agent: value.agent } : {}),
        },
        authority,
      );
    }
    if (!statusOnly) {
      await authority.revalidate();
    }
    authority.assertCurrent();
    if (typeof result !== "string") {
      sendJsonNoStore(res, 200, { ...result, requestId: id });
      return;
    }
    if (result === "unavailable") {
      hide();
      return;
    }
    if (result === "publication_send_limit") {
      fail(
        409,
        result,
        "This publication has reached its durable request limit. Open the existing Team conversation to send another turn.",
      );
      return;
    }
    if (result === "rate_limited") {
      fail(429, result, "Retry the same request after the receipt capacity becomes available.");
      return;
    }
    fail(
      409,
      result,
      result === "source_owned"
        ? "Release this publication before continuing it."
        : "Check the recorded request and destination before sending another instruction.",
    );
  } finally {
    if (!statusOnly) {
      params.limits.inFlightLimiter.release(ip);
    }
  }
}
