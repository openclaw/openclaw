import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import { sendJsonNoStore } from "openclaw/plugin-sdk/http-response-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isJsonContentType,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { sendHttpRequestRejection } from "openclaw/plugin-sdk/webhook-request-guards";
import { BEAM_SEND_RETENTION_SECONDS } from "../continuation-operation-api.js";
import { BEAM_PACKET_ABI, parseBeamPacket } from "../packet-contract/packet-v2.generated.js";
import type {
  BeamPublishInput,
  BeamPublicationOperations,
  BeamReleaseInput,
} from "../publication-operation-api.js";
import type { BeamPublisher } from "../upload-operation-api.js";
import type { BeamContinueService } from "./continuation-v2.js";
import { readBeamDestination } from "./destination-v2.js";
import { handleBeamSendRequest } from "./http-v2-conversation.js";
import { createBeamIngressLimits } from "./http.js";
import { packetDigest, snapshotBytes } from "./packet-state.js";
import { BEAM_V2_API, parsePublicationId, publicationHead } from "./publication.js";
import {
  MAX_SCREENSHOT_BYTES,
  readScreenshotEnvelope,
  SCREENSHOT_MEDIA_TYPE,
  type BeamScreenshot,
} from "./screenshot.js";
import type { BeamPublication } from "./store.js";
import { BEAM_MAX_BODY_BYTES, type BeamHandoff } from "./types.js";

type ReadAuthority = GatewayRequestAuthorityV1;

function beamError(status: number, code: string, message: string) {
  return {
    ok: false,
    error: {
      code,
      retry:
        status === 503 || status === 429
          ? "same_request"
          : status === 412 ||
              code === "released" ||
              code === "source_owned" ||
              code === "needs_reconciliation"
            ? "after_reconcile"
            : "never",
      message,
    },
  };
}

function fail(res: ServerResponse, status: number, code: string, message: string) {
  sendJsonNoStore(res, status, beamError(status, code, message));
}

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function publisherFor(auth: ReadAuthority): BeamPublisher | undefined {
  if (auth.scopes.includes("operator.admin") || auth.scopes.includes("operator.write")) {
    return {
      kind: "staff",
      profileId: auth.personProfileId,
      attributionProfileId: auth.attributionProfileId,
    };
  }
  if (
    auth.personProfileId &&
    auth.requiredGrantPluginId === "visitor-access" &&
    auth.scopes.includes("operator.sessions.write")
  ) {
    return { kind: "guest", profileId: auth.personProfileId };
  }
  return undefined;
}

export function createBeamV2Handler(options: {
  limits?: ReturnType<typeof createBeamIngressLimits>;
  continuation?: BeamContinueService;
  getScreenshot?: (beamId: string, digest: string) => Promise<BeamScreenshot | undefined>;
  readPublication: (beamId: string) => Promise<BeamPublication>;
  putSnapshot: (
    input: BeamPublishInput,
    assertCurrent: () => void,
  ) => Promise<BeamPublicationOperations["publish"]["output"]>;
  releasePublication: (
    input: BeamReleaseInput,
    assertCurrent: () => void,
  ) => Promise<BeamPublicationOperations["release"]["output"]>;
  currentAuthority(): ReadAuthority | undefined;
  controlUiBasePath(): string | undefined;
}) {
  const limits = options.limits ?? createBeamIngressLimits();
  const { rateLimiter: rate, inFlightLimiter: inFlight } = limits;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const admitted = options.currentAuthority();
    if (!admitted) {
      fail(res, 401, "authentication_required", "Sign in to the receiving Gateway.");
      return true;
    }
    // The host distinguishes revoked credentials from an unavailable access policy.
    // Preserve the original rejection even if a worker serializes the error at admission.
    const publisher = publisherFor(admitted);
    const write = req.method !== "GET";
    const sharedRead = admitted.scopes.includes("operator.read") || publisher?.kind === "staff";
    const grant =
      publisher?.kind === "guest" && (write || !sharedRead) ? "visitor-access" : undefined;
    const effectGrant = write ? grant : undefined;
    const canRead = (row: BeamHandoff) =>
      sharedRead || (publisher?.kind === "guest" && row.publisherProfileId === publisher.profileId);
    let admissionFailure: { error: unknown } | undefined;
    const authority: ReadAuthority = {
      ...admitted,
      assertCurrent(requiredGrantPluginId = effectGrant) {
        try {
          admitted.assertCurrent(requiredGrantPluginId);
        } catch (error) {
          admissionFailure = { error };
          throw error;
        }
      },
      async revalidate(requiredGrantPluginId = effectGrant) {
        try {
          await admitted.revalidate(requiredGrantPluginId);
        } catch (error) {
          admissionFailure = { error };
          throw error;
        }
      },
    };
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const path = pathname.slice(BEAM_V2_API.length).split("/").slice(1);
    const unavailable = () =>
      fail(res, 404, "unavailable", "This Beam publication is unavailable.");
    try {
      if (write) {
        await authority.revalidate();
      }
      authority.assertCurrent(grant);
      const selected =
        path[0] === "publications" && path[1] ? parsePublicationId(path[1]) : undefined;
      const send = req.method === "POST" && path.length === 3 && path[2] === "continue";
      const requestStatus = req.method === "GET" && path.length === 4 && path[2] === "requests";
      if (selected && (send || requestStatus) && options.continuation) {
        await handleBeamSendRequest({
          req,
          res,
          authority,
          publication: selected,
          service: options.continuation,
          limits,
          readPublication: options.readPublication,
          canRead,
          canWrite: Boolean(publisher),
          requestId: requestStatus ? path[3] : undefined,
          uuid: REQUEST_ID,
          fail: (code, machine, message) => fail(res, code, machine, message),
        });
        return true;
      }
      if (req.method === "POST" && path.length === 3 && selected && path[2] === "release") {
        if (!publisher?.profileId) {
          unavailable();
          return true;
        }
        const requestId = req.headers["idempotency-key"];
        const revision = req.headers["if-match"];
        if (
          typeof requestId !== "string" ||
          !REQUEST_ID.test(requestId) ||
          typeof revision !== "string" ||
          !/^"[^"\s]{1,128}"$/.test(revision) ||
          req.headers["if-none-match"] !== undefined
        ) {
          fail(
            res,
            400,
            "invalid_request",
            "Use a UUID Idempotency-Key and the exact selected revision in If-Match.",
          );
          return true;
        }
        if (!isJsonContentType(req.headers["content-type"])) {
          fail(res, 415, "unsupported_media", "Submit a JSON release request.");
          return true;
        }
        const ip = authority.clientIp ?? req.socket.remoteAddress ?? "unknown";
        if (rate.isRateLimited(ip) || !inFlight.tryAcquire(ip)) {
          res.setHeader("Retry-After", "60");
          fail(res, 429, "rate_limited", "Retry after the current limit window.");
          return true;
        }
        try {
          let body: unknown;
          const raw = await readRequestBodyWithLimit(req, {
            maxBytes: 1024,
            timeoutMs: 10_000,
            destroyOnLimit: false,
          });
          try {
            body = JSON.parse(raw);
          } catch {
            body = undefined;
          }
          if (
            !isRecord(body) ||
            Object.keys(body).length !== 1 ||
            typeof body.digest !== "string" ||
            !/^sha256:[a-f0-9]{64}$/.test(body.digest)
          ) {
            fail(res, 400, "invalid_request", "Release requires the selected packet digest.");
            return true;
          }
          await authority.revalidate();
          const result = await options.releasePublication(
            {
              ...selected,
              requestId: requestId.toLowerCase(),
              revision,
              digest: body.digest,
              profileId: publisher.profileId,
            },
            () => authority.assertCurrent(),
          );
          await authority.revalidate();
          authority.assertCurrent();
          if (typeof result === "string") {
            if (result === "unavailable") {
              unavailable();
            } else {
              fail(
                res,
                result === "revision_changed" ? 412 : result === "expired" ? 410 : 409,
                result,
                "Inspect the selected publication before retrying release.",
              );
            }
            return true;
          }
          const head = publicationHead(
            result,
            result.digest,
            options.controlUiBasePath(),
            pathname,
          );
          res.setHeader("ETag", head.revision);
          sendJsonNoStore(res, 200, head);
        } finally {
          inFlight.release(ip);
        }
        return true;
      }

      if (
        req.method === "PUT" &&
        path.length === 2 &&
        path[0] === "snapshots" &&
        /^[a-f0-9]{32}$/.test(path[1]!)
      ) {
        if (!publisher) {
          fail(res, 403, "forbidden", "The current account cannot publish a snapshot.");
          return true;
        }
        const requestId = req.headers["idempotency-key"];
        const ifMatch = req.headers["if-match"];
        const create = req.headers["if-none-match"];
        if (
          typeof requestId !== "string" ||
          !REQUEST_ID.test(requestId) ||
          !(
            (create === "*" && ifMatch === undefined) ||
            (create === undefined &&
              typeof ifMatch === "string" &&
              /^"[^"\s]{1,128}"$/.test(ifMatch))
          )
        ) {
          fail(
            res,
            400,
            "invalid_request",
            "Use a UUID Idempotency-Key and one create or revision precondition.",
          );
          return true;
        }
        const rich =
          req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ===
          SCREENSHOT_MEDIA_TYPE;
        if (rich ? !options.getScreenshot : !isJsonContentType(req.headers["content-type"])) {
          fail(res, 415, "unsupported_media", "Submit a supported snapshot representation.");
          return true;
        }
        const ip = authority.clientIp ?? req.socket.remoteAddress ?? "unknown";
        if (rate.isRateLimited(ip) || !inFlight.tryAcquire(ip)) {
          res.setHeader("Retry-After", "60");
          fail(res, 429, "rate_limited", "Retry this request after the current limit window.");
          return true;
        }
        try {
          // The shared bounded body reader exposes a lossless one-byte encoding. Decode
          // strictly in the packet validator before converting accepted bytes to text.
          const raw = Buffer.from(
            await readRequestBodyWithLimit(req, {
              maxBytes: rich
                ? Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 6 * BEAM_MAX_BODY_BYTES + 2048
                : BEAM_MAX_BODY_BYTES,
              timeoutMs: 10_000,
              encoding: "latin1",
              destroyOnLimit: false,
            }),
            "latin1",
          );
          let packet;
          let image: BeamScreenshot | undefined;
          let packetBytes: Buffer = raw;
          try {
            if (rich) {
              const envelope = readScreenshotEnvelope(raw);
              packetBytes = envelope.packet;
              image = envelope.image;
            }
            packet = parseBeamPacket(packetBytes);
            if (packet.beamId !== path[1]) {
              throw new Error("Beam ID mismatch");
            }
          } catch {
            fail(
              res,
              400,
              "invalid_packet",
              rich
                ? "Submit one bounded PNG with its display filename and a valid v2 packet for this Beam ID."
                : "Preview a valid v2 packet with the same Beam ID as the URL.",
            );
            return true;
          }
          await authority.revalidate();
          const packetText = packetBytes.toString("utf8");
          const result = await options.putSnapshot(
            {
              upload: { ...packet, version: 1 },
              publisher,
              requestId: requestId.toLowerCase(),
              receivedAt: Date.now(),
              ifMatch: ifMatch ?? null,
              digest: packetDigest(packetText),
              packetText,
              ...(image ? { image } : {}),
            },
            () => authority.assertCurrent(),
          );
          await authority.revalidate();
          authority.assertCurrent();
          if (typeof result === "object" && "refusal" in result) {
            res.setHeader("Retry-After", String(result.retryAfterSeconds));
            fail(
              res,
              429,
              "rate_limited",
              "The seven-day receipt limit for this publisher is full. Retry the same request with its original Idempotency-Key after Retry-After.",
            );
            return true;
          }
          if (typeof result === "string") {
            const status = {
              unavailable: 404,
              released: 409,
              revision_changed: 412,
              request_identity_conflict: 409,
              rate_limited: 429,
            }[result];
            fail(
              res,
              status,
              result,
              result === "unavailable"
                ? "This Beam publication is unavailable."
                : result === "rate_limited"
                  ? "The receiver has reached its snapshot or write receipt capacity. Keep the original Idempotency-Key and retry after an entry expires, or ask an operator to free snapshot space."
                  : "The snapshot write was declined. Inspect the current publication before retrying.",
            );
            return true;
          }
          const head = publicationHead(
            result,
            result.digest,
            options.controlUiBasePath(),
            pathname,
            publisher.profileId,
          );
          res.setHeader("ETag", head.revision);
          res.setHeader("Beam-Digest", result.digest);
          sendJsonNoStore(res, 200, { ...head, disposition: result.disposition });
        } finally {
          inFlight.release(ip);
        }
        return true;
      }
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, PUT, POST");
        fail(res, 405, "method_not_allowed", "Use a method supported by the Beam receiver.");
        return true;
      }
      if (path.length === 1 && path[0] === "capabilities") {
        const allowed = Boolean(publisher || authority.scopes.includes("operator.read"));
        sendJsonNoStore(res, 200, {
          protocol: 2,
          packetVersions: [BEAM_PACKET_ABI],
          operations: [
            ...(allowed ? ["read", "resolve"] : []),
            ...(publisher ? ["publish"] : []),
            ...(publisher && options.getScreenshot ? ["publishScreenshot"] : []),
            ...(publisher?.profileId ? ["release"] : []),
            ...(publisher && options.continuation ? ["continue"] : []),
          ],
          maxBodyBytes: BEAM_MAX_BODY_BYTES,
          ...(publisher && options.getScreenshot
            ? { maxScreenshotBytes: MAX_SCREENSHOT_BYTES }
            : {}),
          sendReceiptRetentionSeconds: options.continuation ? BEAM_SEND_RETENTION_SECONDS : 0,
        });
        return true;
      }
      const [kind, id = "", operation] = path;
      const publication =
        kind === "publications" &&
        (operation === "snapshot" || operation === "destination" || operation === "image")
          ? selected
          : undefined;
      const beamId =
        publication?.beamId ??
        (kind === "snapshots" &&
        (operation === "head" || operation === "snapshot") &&
        /^[a-f0-9]{32}$/.test(id)
          ? id
          : undefined);
      if (path.length !== 3 || !beamId) {
        unavailable();
        return true;
      }
      const retained = await options.readPublication(beamId).catch(() => undefined);
      // This admitted read may finish after a role edit. A disconnected request may not.
      authority.assertCurrent();
      if (!retained) {
        fail(res, 503, "temporary", "The receiving Gateway could not read the publication.");
        return true;
      }
      const { snapshot, ownership } = retained;
      const row = snapshot ?? ownership;
      if (
        !row ||
        !canRead(row) ||
        (publication && row.publicationId !== publication.publicationGeneration)
      ) {
        unavailable();
        return true;
      }
      if (operation === "destination") {
        const destination = await readBeamDestination(row, Boolean(snapshot), authority);
        authority.assertCurrent();
        if (destination === "unavailable") {
          unavailable();
        } else if (destination === "source_owned") {
          fail(res, 409, "source_owned", "Release this publication before continuing it.");
        } else {
          sendJsonNoStore(
            res,
            200,
            destination.state === "ready"
              ? { state: destination.state, reference: destination.reference }
              : destination,
          );
        }
        return true;
      }
      if (!snapshot) {
        fail(res, 410, "expired", "The snapshot is no longer retained.");
        return true;
      }
      if (operation === "image") {
        const image =
          snapshot.presentationDigest &&
          (await options.getScreenshot?.(beamId, snapshot.presentationDigest));
        authority.assertCurrent(grant);
        if (!image) {
          unavailable();
          return true;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(Buffer.from(image.png, "base64"));
        return true;
      }
      const entity = snapshotBytes(snapshot);
      const digest = packetDigest(entity);
      const head = publicationHead(
        snapshot,
        digest,
        options.controlUiBasePath(),
        pathname,
        publisher?.profileId,
      );
      if (
        kind === "snapshots" &&
        operation === "snapshot" &&
        (snapshot.publicationId || req.headers["if-match"] !== head.revision)
      ) {
        fail(res, 412, "revision_changed", "Inspect the current snapshot before reading it.");
        return true;
      }
      res.setHeader("ETag", head.revision);
      res.setHeader("Beam-Digest", digest);
      if (operation === "head") {
        sendJsonNoStore(res, 200, head);
      } else {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(entity);
      }
    } catch (error) {
      if (admissionFailure) {
        throw admissionFailure.error;
      }
      if (isRequestBodyLimitError(error) && !res.writableEnded && !res.destroyed) {
        const tooLarge = error.code === "PAYLOAD_TOO_LARGE";
        const status = tooLarge ? 413 : 503;
        const body = beamError(
          status,
          tooLarge ? "too_large" : "temporary",
          tooLarge
            ? "The request body exceeds the size limit for this operation."
            : "The request body could not be read.",
        );
        // A response-first body limit has already selected this connection for closure.
        // Finish its framed rejection so the next request opens a usable connection.
        res.setHeader("Cache-Control", "no-store");
        await sendHttpRequestRejection(
          req,
          res,
          status,
          JSON.stringify(body),
          "application/json; charset=utf-8",
        );
        return true;
      }
      if (!res.writableEnded && !res.destroyed) {
        authority.assertCurrent();
        fail(res, 503, "temporary", "The receiving Gateway could not complete the request.");
      }
    }
    return true;
  };
}
