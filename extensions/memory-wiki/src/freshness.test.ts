import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWikiInjectable, isWikiInjectableSync } from "./freshness.js";

async function createCacheFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-freshness-"));
  const cacheDir = path.join(rootDir, ".openclaw-wiki", "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  return {
    digestPath: path.join(cacheDir, "agent-digest.json"),
    claimsPath: path.join(cacheDir, "claims.jsonl"),
    manifestPath: path.join(cacheDir, "wiki-cache-manifest.json"),
  };
}

describe("isWikiInjectable", () => {
  it("rejects a fresh digest when claims are stale", async () => {
    const fixture = await createCacheFixture();
    const now = new Date("2026-05-21T06:00:00.000Z");
    await fs.writeFile(fixture.digestPath, '{"claimCount":1,"pages":[]}\n', "utf8");
    await fs.writeFile(fixture.claimsPath, '{"id":"claim-1"}\n', "utf8");
    await fs.utimes(fixture.digestPath, now, now);
    const stale = new Date(now.getTime() - 30 * 60 * 60 * 1000);
    await fs.utimes(fixture.claimsPath, stale, stale);

    const result = await isWikiInjectable({
      now,
      digestPath: fixture.digestPath,
      claimsPath: fixture.claimsPath,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(result.injectable).toBe(false);
    expect(result.reason).toBe("claims_stale");
    expect(result.outputs.digest.stale).toBe(false);
    expect(result.outputs.claims.stale).toBe(true);
  });

  it("requires manifest when requested by the caller", async () => {
    const fixture = await createCacheFixture();
    const now = new Date("2026-05-21T06:00:00.000Z");
    await fs.writeFile(fixture.digestPath, '{"claimCount":1,"pages":[]}\n', "utf8");
    await fs.writeFile(fixture.claimsPath, '{"id":"claim-1"}\n', "utf8");
    await fs.utimes(fixture.digestPath, now, now);
    await fs.utimes(fixture.claimsPath, now, now);

    const result = await isWikiInjectable({
      now,
      digestPath: fixture.digestPath,
      claimsPath: fixture.claimsPath,
      manifestPath: fixture.manifestPath,
      maxAgeMs: 24 * 60 * 60 * 1000,
      requiredOutputs: ["digest", "claims", "manifest"],
    });

    expect(result.injectable).toBe(false);
    expect(result.reason).toBe("manifest_missing");
  });

  it("uses the same injectable contract from synchronous prompt paths", async () => {
    const fixture = await createCacheFixture();
    const now = new Date("2026-05-21T06:00:00.000Z");
    await fs.writeFile(fixture.digestPath, '{"claimCount":1,"pages":[]}\n', "utf8");
    await fs.writeFile(fixture.claimsPath, '{"id":"claim-1"}\n', "utf8");
    await fs.writeFile(fixture.manifestPath, '{"schema_version":"test"}\n', "utf8");
    await fs.utimes(fixture.digestPath, now, now);
    await fs.utimes(fixture.claimsPath, now, now);
    await fs.utimes(fixture.manifestPath, now, now);

    const result = isWikiInjectableSync({
      now,
      digestPath: fixture.digestPath,
      claimsPath: fixture.claimsPath,
      manifestPath: fixture.manifestPath,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(result.injectable).toBe(true);
    expect(result.requiredOutputs).toEqual(["digest", "claims", "manifest"]);
  });
});
