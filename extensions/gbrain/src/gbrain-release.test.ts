import { describe, expect, it } from "vitest";
import { attestsGbrainRelease } from "./gbrain-release.js";

const ASSET = "gbrain-darwin-arm64";
const DIGEST = "a".repeat(64);
const RELEASE_BUILDER =
  "https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/master";

/** A build-provenance bundle shaped like GitHub's attestation API response. */
function bundle(builder: string, subjects: Array<{ name: string; sha256: string }>) {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: subjects.map(({ name, sha256 }) => ({ name, digest: { sha256 } })),
    predicate: { runDetails: { builder: { id: builder } } },
  };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } };
}

describe("attestsGbrainRelease", () => {
  it("accepts only GBrain's release workflow attesting this asset at this digest", () => {
    const subjects = [{ name: ASSET, sha256: DIGEST }];
    expect(attestsGbrainRelease(bundle(RELEASE_BUILDER, subjects), ASSET, DIGEST)).toBe(true);
    // A fork, another workflow, or a branch dispatch of the release workflow.
    for (const builder of [
      "https://github.com/someone/gbrain/.github/workflows/release.yml@refs/heads/master",
      "https://github.com/garrytan/gbrain/.github/workflows/ci.yml@refs/heads/master",
      "https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/feature",
    ]) {
      expect(attestsGbrainRelease(bundle(builder, subjects), ASSET, DIGEST)).toBe(false);
    }
    // The right workflow, but for another asset or other bytes.
    expect(
      attestsGbrainRelease(bundle(RELEASE_BUILDER, subjects), "gbrain-linux-x64", DIGEST),
    ).toBe(false);
    expect(attestsGbrainRelease(bundle(RELEASE_BUILDER, subjects), ASSET, "b".repeat(64))).toBe(
      false,
    );
    expect(
      attestsGbrainRelease({ dsseEnvelope: { payload: "not base64 json" } }, ASSET, DIGEST),
    ).toBe(false);
  });
});
