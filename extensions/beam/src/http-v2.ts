import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import { sendJsonNoStore } from "openclaw/plugin-sdk/http-response-runtime";
import {
  BEAM_V2_API,
  packetDigest,
  parsePublicationId,
  publicationHead,
  snapshotBytes,
} from "./publication.js";
import type { BeamPublication } from "./store.js";
import { BEAM_MAX_BODY_BYTES } from "./types.js";

type ReadAuthority = GatewayRequestAuthorityV1;

function fail(res: ServerResponse, status: number, code: string, message: string) {
  sendJsonNoStore(res, status, {
    ok: false,
    error: { code, retry: status === 503 ? "same_request" : "never", message },
  });
}

function canReadShared(authority: ReadAuthority): boolean {
  return authority.scopes.some((scope) =>
    ["operator.admin", "operator.read", "operator.write"].includes(scope),
  );
}

function canReadOwned(authority: ReadAuthority): boolean {
  return Boolean(
    authority.personProfileId &&
    authority.requiredGrantPluginId === "visitor-access" &&
    authority.scopes.includes("operator.sessions.write"),
  );
}

export function createBeamV2Handler(options: {
  readPublication: (beamId: string) => Promise<BeamPublication>;
  currentAuthority(): ReadAuthority | undefined;
  controlUiBasePath(): string | undefined;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const authority = options.currentAuthority();
    if (!authority) {
      fail(res, 401, "authentication_required", "Sign in to the receiving Gateway.");
      return true;
    }
    const shared = canReadShared(authority);
    const owned = canReadOwned(authority);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const path = pathname.slice(BEAM_V2_API.length).split("/").slice(1);
    const unavailable = () =>
      fail(res, 404, "unavailable", "This Beam publication is unavailable.");
    authority.assertCurrent(!shared && owned ? "visitor-access" : undefined);
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      fail(res, 405, "method_not_allowed", "Use GET to inspect this receiver.");
      return true;
    }
    if (path.length === 1 && path[0] === "capabilities") {
      sendJsonNoStore(res, 200, {
        protocol: 2,
        packetVersions: [2],
        operations: shared || owned ? ["read"] : [],
        maxBodyBytes: BEAM_MAX_BODY_BYTES,
        sendReceiptRetentionSeconds: 0,
      });
      return true;
    }
    const [kind, id = "", operation] = path;
    const publication =
      kind === "publications" && operation === "snapshot" ? parsePublicationId(id) : undefined;
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
      !(shared || (owned && row.publisherProfileId === authority.personProfileId)) ||
      (publication && row.publicationId !== publication.generation)
    ) {
      unavailable();
      return true;
    }
    if (!snapshot) {
      fail(res, 410, "expired", "The snapshot is no longer retained.");
      return true;
    }
    const entity = snapshotBytes(snapshot);
    const digest = packetDigest(entity);
    const head = publicationHead(snapshot, digest, options.controlUiBasePath(), pathname);
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
    return true;
  };
}
