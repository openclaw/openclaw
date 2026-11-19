import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installGbrainRelease } from "./gbrain-release.js";

const ASSET = "gbrain-darwin-arm64";
const RELEASE_BYTES = "synthetic gbrain release\n";
const DIGEST = createHash("sha256").update(RELEASE_BYTES).digest("hex");
const RELEASE_BUILDER =
  "https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/master";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

/** A build-provenance bundle shaped like GitHub's attestation API response. */
function bundle(builder: string, subjects: Array<{ name: string; sha256: string }>) {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: subjects.map(({ name, sha256 }) => ({ name, digest: { sha256 } })),
    predicate: { runDetails: { builder: { id: builder } } },
  };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } };
}

function serveRelease(attestation: unknown) {
  const responses = new Map([
    ["https://raw.githubusercontent.com/garrytan/gbrain/stable/VERSION", "0.60.734.0\n"],
    [`https://github.com/garrytan/gbrain/releases/download/v0.60.734.0/${ASSET}`, RELEASE_BYTES],
    [
      `https://api.github.com/repos/garrytan/gbrain/attestations/sha256:${DIGEST}`,
      JSON.stringify({ attestations: [{ bundle: attestation }] }),
    ],
  ]);
  vi.spyOn(ssrf, "fetchWithSsrFGuard").mockImplementation(async ({ url }) => {
    const body = responses.get(url);
    if (body === undefined) {
      throw new Error(`Unexpected release request: ${url}`);
    }
    return { response: new Response(body), finalUrl: url, release: async () => {} };
  });
}

describe("installGbrainRelease", () => {
  it("installs the attested bytes as an executable", async () => {
    const destination = path.join(tempDirs.make("gbrain-release-"), "gbrain");
    serveRelease(bundle(RELEASE_BUILDER, [{ name: ASSET, sha256: DIGEST }]));

    await expect(installGbrainRelease(ASSET, destination)).resolves.toBe("0.60.734.0");
    expect(await readFile(destination, "utf8")).toBe(RELEASE_BYTES);
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
  });

  it.each([
    ...[
      "https://github.com/someone/gbrain/.github/workflows/release.yml@refs/heads/master",
      "https://github.com/garrytan/gbrain/.github/workflows/ci.yml@refs/heads/master",
      "https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/feature",
    ].map((builder) => ({
      name: builder,
      attestation: bundle(builder, [{ name: ASSET, sha256: DIGEST }]),
    })),
    {
      name: "another asset",
      attestation: bundle(RELEASE_BUILDER, [{ name: "gbrain-linux-x64", sha256: DIGEST }]),
    },
    {
      name: "different bytes",
      attestation: bundle(RELEASE_BUILDER, [{ name: ASSET, sha256: "b".repeat(64) }]),
    },
    { name: "malformed payload", attestation: { dsseEnvelope: { payload: "not base64 json" } } },
  ])("preserves the installed binary and discards $name", async ({ attestation }) => {
    const directory = tempDirs.make("gbrain-release-");
    const destination = path.join(directory, "gbrain");
    await writeFile(destination, "previous release");
    serveRelease(attestation);

    await expect(installGbrainRelease(ASSET, destination)).rejects.toThrow(
      "no build-provenance attestation",
    );
    expect(await readFile(destination, "utf8")).toBe("previous release");
    expect(await readdir(directory)).toEqual(["gbrain"]);
  });
});
