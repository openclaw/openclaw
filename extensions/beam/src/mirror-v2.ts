import { createHash, randomUUID } from "node:crypto";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  GuardedFetchRedirectError,
  isLoopbackHost,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseBeamPacket } from "../packet-contract/packet-v2.generated.js";
import { BEAM_MAX_BODY_BYTES, BEAM_RETENTION_MS } from "./types.js";

export type BeamMirrorV2Head = { publicationId: string; revision: string; sha256: string };
export type BeamMirrorV2Intent = {
  requestId: string;
  sha256: string;
  createdAt: number;
  prior: BeamMirrorV2Head;
};

type Destination = {
  endpoint: string;
  token?: string | null;
  beamId: string;
  assertCurrent: () => void;
  signal: AbortSignal;
};

type Source = Destination & { raw: Uint8Array };

type Outcome = { state: "published"; head: BeamMirrorV2Head } | { state: "released" | "conflict" };

const digest = (raw: Uint8Array) => "sha256:" + createHash("sha256").update(raw).digest("hex");
const validDigest = /^sha256:[a-f0-9]{64}$/;
const validRevision = /^"[^"\s]{1,128}"$/;
const validPublicationId = /^[A-Za-z0-9_-][A-Za-z0-9._~-]{0,255}$/;

export function prepareBeamMirrorV2Intent(
  raw: Uint8Array,
  known: BeamMirrorV2Head,
): BeamMirrorV2Intent {
  if (raw.byteLength > BEAM_MAX_BODY_BYTES) {
    throw new Error("Beam mirror packet exceeds 56 KiB");
  }
  return {
    requestId: randomUUID(),
    sha256: digest(raw),
    createdAt: Date.now(),
    prior: { ...known },
  };
}

function receiverUrl(endpoint: string): URL {
  const url = URL.parse(endpoint);
  if (
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) ||
    !url.pathname.replace(/\/$/, "").endsWith("/api/v2/beam")
  ) {
    throw new Error("Configure the final Beam v2 HTTPS endpoint or a loopback HTTP endpoint");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + "/";
  return url;
}

function snapshotUrl(endpoint: string, beamId: string): URL {
  if (!/^[a-f0-9]{32}$/.test(beamId)) {
    throw new Error("Invalid Beam mirror identifier");
  }
  return new URL("snapshots/" + beamId, receiverUrl(endpoint));
}

function receipt(value: unknown, beamId: string): BeamMirrorV2Head {
  if (
    !isRecord(value) ||
    value.beamId !== beamId ||
    typeof value.publicationId !== "string" ||
    !validPublicationId.test(value.publicationId) ||
    typeof value.revision !== "string" ||
    !validRevision.test(value.revision) ||
    typeof value.digest !== "string" ||
    !validDigest.test(value.digest)
  ) {
    throw new Error("Beam mirror receiver returned an invalid publication receipt");
  }
  return { publicationId: value.publicationId, revision: value.revision, sha256: value.digest };
}

// Only the enrolled receiver origin can acknowledge an operation. Recheck live
// consent after DNS preparation, immediately before the guarded request is sent.
async function request(p: Omit<Destination, "beamId">, url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  if (p.token) {
    headers.set("Authorization", "Bearer " + p.token);
  }
  const check = () => {
    p.signal.throwIfAborted();
    p.assertCurrent();
  };
  check();
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: { ...init, headers },
      signal: p.signal,
      beforeRequest: check,
      timeoutMs: 15_000,
      maxRedirects: 0,
      capture: false,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(p.endpoint),
      auditContext: "beam.mirror_v2",
    });
    try {
      check();
      let body: unknown;
      if (response.ok || response.status === 409) {
        const bytes = await readResponseWithLimit(response, 16 * 1024, {
          signal: p.signal,
          timeoutMs: 15_000,
        });
        try {
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          if (response.ok) {
            throw new Error("invalid receipt");
          }
        }
      }
      check();
      return { status: response.status, body };
    } finally {
      await response.body?.cancel().catch(() => undefined);
      await release();
    }
  } catch (error) {
    check();
    if (error instanceof GuardedFetchRedirectError) {
      return { status: error.status, body: undefined };
    }
  }
  // Keep transport details private. The original intent owns recovery after a lost acknowledgement.
  throw new Error("Beam mirror request could not be verified; retain the saved request");
}

function fenced(status: number) {
  return (status >= 300 && status < 400) || status === 409 || status === 410 || status === 412;
}

const validRequestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function savedPacket(p: Source) {
  if (p.raw.byteLength > BEAM_MAX_BODY_BYTES) {
    throw new Error("Beam mirror packet exceeds 56 KiB");
  }
  const raw = Uint8Array.from(p.raw);
  if (parseBeamPacket(raw).beamId !== p.beamId) {
    throw new Error("Beam mirror packet does not belong to the selected source");
  }
  return raw;
}

// An explicit enrollment must remain recoverable by the same publisher after credential rotation.
export async function requireBeamMirrorPublisher(p: Omit<Destination, "beamId">): Promise<void> {
  const url = new URL("capabilities", receiverUrl(p.endpoint));
  const { status, body } = await request(p, url.href, { method: "GET" });
  if (
    status !== 200 ||
    !isRecord(body) ||
    body.protocol !== 2 ||
    !Array.isArray(body.operations) ||
    !body.operations.includes("publish") ||
    !body.operations.includes("release")
  ) {
    throw new Error(
      "Beam enrollment requires a v2 receiver and verified publisher with publish and release authority",
    );
  }
}

/** The operator's explicit first share is the only create-capable call. A missing
 * receipt does not establish an enrollment, even if the head later has equal bytes. */
export async function enrollBeamMirrorV2(p: Source & { requestId: string }): Promise<Outcome> {
  if (!validRequestId.test(p.requestId)) {
    throw new Error("Beam mirror enrollment requires a UUID");
  }
  const raw = savedPacket(p);
  return write(p, snapshotUrl(p.endpoint, p.beamId), raw, p.requestId, digest(raw));
}

type HeadResult =
  | { state: "conflict" }
  | { state: "writable" | "released"; head: BeamMirrorV2Head; canRelease: boolean };

async function readHead(p: Destination, url: URL): Promise<HeadResult> {
  const seen = await request(p, url.href + "/head", { method: "GET" });
  if (seen.status === 404 || fenced(seen.status)) {
    return { state: "conflict" };
  }
  if (seen.status !== 200) {
    throw new Error(`Beam mirror head lookup failed (HTTP ${seen.status})`);
  }
  if (!isRecord(seen.body) || seen.body.beamId !== p.beamId) {
    throw new Error("Beam mirror receiver returned an invalid head");
  }
  if (seen.body.state === "legacy_unbound") {
    return { state: "conflict" };
  }
  if (seen.body.state !== "writable" && seen.body.state !== "released") {
    throw new Error("Beam mirror receiver returned an unknown publication state");
  }
  return {
    state: seen.body.state,
    head: receipt(seen.body, p.beamId),
    canRelease: seen.body.canRelease === true,
  };
}

// Matching bytes identify a candidate for an explicit rebind. They cannot establish
// which receiver accepted a lost create or grant the scheduler an active enrollment.
export async function inspectBeamMirrorV2Enrollment(
  p: Destination & { sha256: string; pendingSha256?: string },
): Promise<{ state: "observed"; head: BeamMirrorV2Head } | { state: "conflict" | "released" }> {
  if (!validDigest.test(p.sha256)) {
    throw new Error("Beam mirror enrollment requires the saved packet digest");
  }
  const seen = await readHead(p, snapshotUrl(p.endpoint, p.beamId));
  if (
    seen.state === "conflict" ||
    (seen.head.sha256 !== p.sha256 && seen.head.sha256 !== p.pendingSha256)
  ) {
    return { state: "conflict" };
  }
  if (seen.state === "released") {
    return { state: "released" };
  }
  // Read access may be shared with other people. Only the original publisher
  // has release authority on a writable generation.
  return seen.canRelease ? { state: "observed", head: seen.head } : { state: "conflict" };
}

export async function publishBeamMirrorV2(
  p: Source & { intent: BeamMirrorV2Intent },
): Promise<Outcome> {
  const { intent, beamId } = p;
  const raw = savedPacket(p);
  if (
    digest(raw) !== intent.sha256 ||
    !validRequestId.test(intent.requestId) ||
    !Number.isSafeInteger(intent.createdAt) ||
    !intent.prior ||
    !validPublicationId.test(intent.prior.publicationId) ||
    !validRevision.test(intent.prior.revision) ||
    !validDigest.test(intent.prior.sha256)
  ) {
    throw new Error("Beam mirror saved packet or write intent is invalid");
  }
  // The receiver can discard idempotency receipts after its retention window.
  const age = Date.now() - intent.createdAt;
  if (age < 0 || age >= BEAM_RETENTION_MS) {
    return { state: "conflict" };
  }
  const url = snapshotUrl(p.endpoint, beamId);
  const seen = await readHead(p, url);
  if (seen.state === "conflict" || seen.head.publicationId !== intent.prior.publicationId) {
    return { state: "conflict" };
  }
  if (seen.state === "released") {
    return { state: "released" };
  }
  const head = seen.head;
  // Equal content never establishes a binding. Across a lost response, only a replay
  // using our original id and original revision can recover this operation's receipt.
  if (head.revision === intent.prior.revision) {
    if (head.sha256 !== intent.prior.sha256) {
      return { state: "conflict" };
    }
  } else if (head.sha256 !== intent.sha256) {
    return { state: "conflict" };
  }
  return write(p, url, raw, intent.requestId, intent.sha256, intent.prior);
}

async function write(
  p: Source,
  url: URL,
  raw: Uint8Array<ArrayBuffer>,
  requestId: string,
  sha256: string,
  prior?: BeamMirrorV2Head,
): Promise<Outcome> {
  const sent = await request(p, url.href, {
    method: "PUT",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
      ...(prior ? { "If-Match": prior.revision } : { "If-None-Match": "*" }),
    },
  });
  if (fenced(sent.status)) {
    const released =
      sent.status === 409 &&
      isRecord(sent.body) &&
      isRecord(sent.body.error) &&
      sent.body.error.code === "released";
    if (released && prior) {
      // A conflict response does not identify the publication that was released.
      // Retire this enrollment only when the subsequent head names its bound generation.
      const current = await readHead(p, url);
      if (current.state === "released" && current.head.publicationId === prior.publicationId) {
        return { state: "released" };
      }
    }
    return { state: "conflict" };
  }
  if (
    (sent.status !== 200 && sent.status !== 201) ||
    !isRecord(sent.body) ||
    sent.body.state !== "writable" ||
    (sent.body.disposition !== "applied" && sent.body.disposition !== "unchanged")
  ) {
    throw new Error(
      `Beam mirror write was not acknowledged (HTTP ${sent.status}); retain the saved request`,
    );
  }
  const head = receipt(sent.body, p.beamId);
  if (!prior && (!isRecord(sent.body) || sent.body.canRelease !== true)) {
    throw new Error(
      "Beam receiver did not attest ownership of the created publication; inspect it before confirming",
    );
  }
  if (prior && head.publicationId !== prior.publicationId) {
    return { state: "conflict" };
  }
  if (head.sha256 !== sha256) {
    throw new Error("Beam mirror receipt does not match the saved packet");
  }
  return { state: "published", head };
}
