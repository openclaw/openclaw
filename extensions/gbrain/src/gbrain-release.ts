import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Installs GBrain's standalone release binary the way GBrain's own binary
 * self-update does (`src/core/binary-self-update.ts`): the stable channel's
 * release asset, accepted only when GitHub's build-provenance attestation for
 * its SHA-256 names that asset and GBrain's release workflow. Nothing is made
 * executable or moved into place before that check passes.
 */

const REPO = "garrytan/gbrain";
/** GBrain's documented stable-channel version file (docs/RELEASING.md, "Stable channel promotion"). */
const STABLE_VERSION_URL = `https://raw.githubusercontent.com/${REPO}/stable/VERSION`;
/** Mirrors GBrain's EXPECTED_BUILDER_IDS: only its release workflow on master builds release binaries. */
const RELEASE_BUILDER_ID = `https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/master`;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_IDLE_MS = 60_000;
const HEADERS = { "User-Agent": "openclaw-gbrain", Accept: "application/vnd.github+json" };

async function getText(url: string): Promise<string> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: { headers: HEADERS },
    timeoutMs: API_TIMEOUT_MS,
    capture: false,
    auditContext: "gbrain-release",
  });
  try {
    if (!response.ok) {
      throw new Error(
        response.status === 403 || response.status === 429
          ? `GitHub refused ${url} (HTTP ${response.status}); its unauthenticated API limit for this network is used up and resets within an hour.`
          : `${url} returned HTTP ${response.status}.`,
      );
    }
    return await response.text();
  } finally {
    await release();
  }
}

async function getJson(url: string): Promise<Record<string, unknown> | undefined> {
  return asOptionalRecord(JSON.parse(await getText(url)));
}

/** True when an attestation bundle binds `digest` to `asset` and GBrain's release workflow. */
export function attestsGbrainRelease(bundle: unknown, asset: string, digest: string): boolean {
  const payload = asOptionalRecord(asOptionalRecord(bundle)?.dsseEnvelope)?.payload;
  if (typeof payload !== "string") {
    return false;
  }
  let statement: Record<string, unknown> | undefined;
  try {
    statement = asOptionalRecord(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
  } catch {
    return false;
  }
  const runDetails = asOptionalRecord(asOptionalRecord(statement?.predicate)?.runDetails);
  if (asOptionalRecord(runDetails?.builder)?.id !== RELEASE_BUILDER_ID) {
    return false;
  }
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  return subjects.some((entry) => {
    const subject = asOptionalRecord(entry);
    return subject?.name === asset && asOptionalRecord(subject.digest)?.sha256 === digest;
  });
}

/**
 * Download the stable release's `asset` to `destination` (made executable).
 * Throws with a reason a person can act on; `destination` is untouched on failure.
 */
export async function installGbrainRelease(asset: string, destination: string): Promise<string> {
  const version = (await getText(STABLE_VERSION_URL)).trim();
  if (!/^\d+(\.\d+){2,3}$/.test(version)) {
    throw new Error(`GBrain's stable channel names no release (${STABLE_VERSION_URL}).`);
  }
  // The release download URL is fixed by GitHub; only the attestation needs its API.
  const downloadUrl = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;

  await mkdir(path.dirname(destination), { recursive: true });
  const staged = `${destination}.download-${process.pid}`;
  const hash = createHash("sha256");
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: downloadUrl,
      init: { headers: { "User-Agent": HEADERS["User-Agent"] } },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      streamTimeoutMs: DOWNLOAD_IDLE_MS,
      capture: false,
      auditContext: "gbrain-release",
    });
    try {
      if (!response.ok || !response.body) {
        throw new Error(
          response.status === 404
            ? `GBrain ${version} has no ${asset} release binary.`
            : `Downloading ${asset} returned HTTP ${response.status}.`,
        );
      }
      await pipeline(
        // SAFETY: undici returns the WHATWG stream that node:stream/web describes.
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(staged, { mode: 0o600 }),
      );
    } finally {
      await release();
    }
    const digest = hash.digest("hex");
    const attestations = await getJson(
      `https://api.github.com/repos/${REPO}/attestations/sha256:${digest}`,
    );
    const bundles = Array.isArray(attestations?.attestations) ? attestations.attestations : [];
    const attested = bundles.some((entry) =>
      attestsGbrainRelease(asOptionalRecord(entry)?.bundle, asset, digest),
    );
    if (!attested) {
      throw new Error(
        `The downloaded ${asset} (sha256 ${digest}) has no build-provenance attestation from GBrain's release workflow; it was discarded.`,
      );
    }
    await chmod(staged, 0o755);
    await rename(staged, destination);
    return version;
  } finally {
    await rm(staged, { force: true });
  }
}
