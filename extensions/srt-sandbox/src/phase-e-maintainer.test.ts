import { describe, expect, it } from "vitest";
import {
  assertPhaseEPlatform,
  inspectCanonicalPool,
  leaseStoreCrc,
  PHASE_E_POOL,
  parsePhaseEEvidence,
  redactPhaseEEvidence,
  rollbackCandidates,
  runPhaseEMaintainer,
} from "./phase-e-maintainer.js";

describe("Phase E maintainer policy", () => {
  it("uses exactly the collision-checked N=8 namespace", () => {
    expect(PHASE_E_POOL).toEqual([
      "srt-w0-01",
      "srt-w0-02",
      "srt-w0-03",
      "srt-w0-04",
      "srt-w0-05",
      "srt-w0-06",
      "srt-w0-07",
      "srt-w0-08",
    ]);
    expect(inspectCanonicalPool([])).toBe("absent");
    expect(() => inspectCanonicalPool([{ name: "srt-w0-01", sid: "S-1" }])).toThrow("AMBIGUOUS");
  });
  it("rejects duplicate SIDs and only rolls back its own manifest", () => {
    const accounts = PHASE_E_POOL.map((name) => ({ name, sid: "S-1" }));
    expect(() => inspectCanonicalPool(accounts)).toThrow("AMBIGUOUS");
    const manifest = {
      version: 1 as const,
      generation: 1,
      owner: "srt-phase-e-maintainer" as const,
      invocationId: "run-1",
      createdAccounts: [{ name: "srt-w0-01", sid: "S-1-2" }],
      crc32: "x",
    };
    expect(rollbackCandidates(manifest, "run-1")).toEqual(["srt-w0-01"]);
    expect(() => rollbackCandidates(manifest, "other")).toThrow("OWNERSHIP");
  });
  it("has stable CRC, rejects free-form evidence, and fails closed off Windows", () => {
    expect(leaseStoreCrc(1, PHASE_E_POOL)).toBe(leaseStoreCrc(1, PHASE_E_POOL));
    expect(() => redactPhaseEEvidence("password=hunter2")).toThrow("MUST_BE_TYPED");
    expect(() => assertPhaseEPlatform("darwin")).toThrow("UNSUPPORTED_PLATFORM");
    expect(() => runPhaseEMaintainer("preflight", { run: () => "bad" }, "linux")).toThrow(
      "UNSUPPORTED_PLATFORM",
    );
  });
  it("accepts only allowlisted typed evidence", () => {
    const valid = JSON.stringify({
      schema: "phase-e-evidence/v1",
      mode: "preflight",
      outcome: "PREFLIGHT_OK",
      maintainer: { pid: 42, creationTime: "t" },
      canonicalAccounts: [],
      legacyAccountCount: 10,
      seclogon: "RUNNING",
      manifestGeneration: 0,
    });
    expect(parsePhaseEEvidence(valid, "preflight").legacyAccountCount).toBe(10);
    expect(() => parsePhaseEEvidence(JSON.stringify({ password: "hunter2" }), "preflight")).toThrow(
      "INVALID_EVIDENCE",
    );
    expect(() =>
      parsePhaseEEvidence(
        JSON.stringify({ ...JSON.parse(valid), nested: { token: "x" } }),
        "preflight",
      ),
    ).toThrow("INVALID_EVIDENCE");
    expect(() =>
      parsePhaseEEvidence(
        JSON.stringify({ ...JSON.parse(valid), outcome: "password=hunter2" }),
        "preflight",
      ),
    ).toThrow("INVALID_EVIDENCE");
    expect(() =>
      parsePhaseEEvidence(
        JSON.stringify({
          ...JSON.parse(valid),
          canonicalAccounts: [{ name: "srt-w0-01", sid: 9 }],
        }),
        "preflight",
      ),
    ).toThrow("INVALID_EVIDENCE");
  });
  it("proves the maintainer source has no delegated execution surface", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./phase-e-maintainer.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(
      /node:child_process|spawn(?:Sync)?\s*\(|powershell|cmd\.exe|netsh|schtasks/i,
    );
  });
});
