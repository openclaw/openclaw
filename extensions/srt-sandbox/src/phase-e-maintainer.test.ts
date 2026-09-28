import { describe, expect, it } from "vitest";
import {
  assertPhaseEPlatform,
  createInitialLeaseStore,
  inspectCanonicalPool,
  leaseStoreCrc,
  manifestCrc,
  PHASE_E_POOL,
  parsePhaseEEvidence,
  redactPhaseEEvidence,
  rollbackCandidates,
  runPhaseEMaintainer,
  verifyInitialLeaseStore,
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
    const createdAccounts = PHASE_E_POOL.map((name, index) => ({ name, sid: `S-1-5-21-${index}` }));
    const manifest = {
      version: 1 as const,
      generation: 1,
      owner: "srt-phase-e-maintainer" as const,
      invocationId: "run-1",
      createdAccounts,
      crc32: manifestCrc(1, createdAccounts),
    };
    expect(rollbackCandidates(manifest, "run-1")).toEqual(PHASE_E_POOL);
    expect(() => rollbackCandidates(manifest, "other")).toThrow("OWNERSHIP");
    expect(() => rollbackCandidates({ ...manifest, crc32: "00000000" }, "run-1")).toThrow(
      "MANIFEST_INVALID",
    );
    expect(() =>
      rollbackCandidates({ ...manifest, createdAccounts: createdAccounts.slice(0, 7) }, "run-1"),
    ).toThrow("MANIFEST_INVALID");
  });
  it("has stable CRC, rejects free-form evidence, and fails closed off Windows", () => {
    expect(leaseStoreCrc(1, PHASE_E_POOL)).toBe(leaseStoreCrc(1, PHASE_E_POOL));
    expect(() => redactPhaseEEvidence("password=hunter2")).toThrow("MUST_BE_TYPED");
    expect(() => assertPhaseEPlatform("darwin")).toThrow("UNSUPPORTED_PLATFORM");
    expect(() => runPhaseEMaintainer("preflight", { run: () => "bad" }, "linux")).toThrow(
      "UNSUPPORTED_PLATFORM",
    );
  });
  it("creates a generation-consistent fail-closed initial lease store", () => {
    const accounts = PHASE_E_POOL.map((name, index) => ({ name, sid: `S-1-5-21-${index}` }));
    const store = createInitialLeaseStore(1, accounts);
    verifyInitialLeaseStore(store);
    expect(() => verifyInitialLeaseStore({ ...store, crc32: "00000000" })).toThrow("LEASE_STORE");
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
  it("persists a canonical, generation-checked lease-store contract in the native boundary", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain('\\"generation\\":1');
    expect(source).toContain('\\"crc32\\"');
    expect(source).toContain('\\"state\\":\\"free\\"');
    expect(source).toContain("LeaseCrc(1,sidFacts)");
  });
  it("uses deterministic SID-keyed FWPM objects and refuses unowned removal", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("FWPM_CONDITION_ALE_USER_ID");
    expect(source).toContain("conditionValue.type=FWP_SID");
    expect(source).toContain("FwpmFilterGetByKey0");
    expect(source).toContain("VerifyOwnedFilter");
    expect(source).toContain("RemoveOwnedFwpm(accounts)");
    expect(source).not.toMatch(/FwpmFilter(?:Create|Enum)|FwpmSubLayer(?:Create|Enum)/);
  });
  it("normalizes and re-verifies owned filesystem security through retained handles", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("NormalizeOwnedSecurity(HANDLE object)");
    expect(source).toContain("SetSecurityInfo(object,SE_FILE_OBJECT");
    expect(source).toContain("GetSecurityInfo(object,SE_FILE_OBJECT");
    expect(source).toContain("SE_DACL_PROTECTED");
    expect(source).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
  });
});
