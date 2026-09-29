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
  runPhaseEFaultInjection,
  verifyInitialLeaseStore,
  verifyRestartIdentity,
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
      maintainer: { pid: 42, creationTime: "133713371337" },
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
    expect(() =>
      parsePhaseEEvidence(
        JSON.stringify({
          ...JSON.parse(valid),
          maintainer: { pid: 42, creationTime: "133713371337", password: "hunter2" },
        }),
        "preflight",
      ),
    ).toThrow("INVALID_EVIDENCE");
    expect(() =>
      parsePhaseEEvidence(
        JSON.stringify({
          ...JSON.parse(valid),
          canonicalAccounts: [
            { name: "srt-w0-01", sid: "S-1-5-21-1" },
            { name: "srt-w0-02", sid: "S-1-5-21-2", token: "x" },
          ],
        }),
        "preflight",
      ),
    ).toThrow("INVALID_EVIDENCE");
    expect(() =>
      parsePhaseEEvidence(JSON.stringify({ ...JSON.parse(valid), maintainer: [] }), "preflight"),
    ).toThrow("INVALID_EVIDENCE");
    expect(() =>
      parsePhaseEEvidence(
        JSON.stringify({ ...JSON.parse(valid), canonicalAccounts: [null] }),
        "preflight",
      ),
    ).toThrow("INVALID_EVIDENCE");
  });
  it("allows only bounded in-process mutation fault points", () => {
    const native = {
      run: (_mode: string, _argument?: string) => {
        throw new Error("PHASE_E_FAULT_INJECTED");
      },
    };
    expect(() => runPhaseEFaultInjection("fwpm", native, "win32")).toThrow(
      "PHASE_E_FAULT_INJECTED",
    );
    expect(() => runPhaseEFaultInjection("fwpm", native, "linux")).toThrow("UNSUPPORTED_PLATFORM");
    expect(() => runPhaseEFaultInjection("profile-scratch", native, "win32")).toThrow(
      "PHASE_E_FAULT_INJECTED",
    );
  });
  it("fails closed for active, stale, and malformed restart identities", () => {
    const recorded = { pid: 42, creationTime: "133713371337" };
    expect(verifyRestartIdentity(recorded, undefined)).toBe("dead");
    expect(() => verifyRestartIdentity(recorded, recorded)).toThrow("MAINTAINER_ACTIVE");
    expect(() => verifyRestartIdentity(recorded, { pid: 42, creationTime: "9" })).toThrow(
      "STALE_PROCESS_IDENTITY",
    );
    expect(() => verifyRestartIdentity({ pid: 0, creationTime: "x" }, undefined)).toThrow(
      "PROCESS_IDENTITY_MISMATCH",
    );
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
    expect(source).toContain("conditionValue.type=FWP_SECURITY_DESCRIPTOR_TYPE");
    expect(source).toContain("condition.conditionValue.sd=&descriptorBlob");
    expect(source).toContain("BuildTrusteeWithSidW(&access.Trustee,sid)");
    expect(source).toContain(
      "BuildSecurityDescriptorW(nullptr,nullptr,1,&access,0,nullptr,nullptr,length,&descriptor)",
    );
    expect(source).toContain("access.grfAccessPermissions=FWP_ACTRL_MATCH_FILTER");
    expect(source).toContain("control&SE_SELF_RELATIVE");
    expect(source).toContain("SecurityDescriptorMatchesSid");
    expect(source).not.toContain("conditionValue.type=FWP_SID");
    expect(source).toContain("FwpmFilterGetByKey0");
    expect(source).toContain("VerifyOwnedFilter");
    expect(source).toContain("RemoveOwnedFwpm(accounts)");
    expect(source).not.toMatch(/FwpmFilter(?:Create|Enum)|FwpmSubLayer(?:Create|Enum)/);
  });
  it("records each WFP filter-add boundary with a one-based slot and numeric status", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain('"PHASE_E_FWPM_STAGE:slot:%zu:%s\\n",index+1,stage');
    expect(source).toContain('"PHASE_E_FWPM_STATUS:slot:%zu:%s:%lu\\n",index+1,operation');
    expect(source).toContain('"PHASE_E_FWPM_FILTER_ADD_FAILED:")+std::to_string(index+1)+":"');
    expect(source).toContain('FwpmStage(i,"before-filter-add")');
    expect(source).toContain('FwpmStatus(i,"filter-add",status)');
    expect(source).toContain('FwpmStage(i,"after-filter-add")');
  });
  it("uses a legal and ownership-verified WFP filter weight", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("constexpr UINT8 kFwpmFilterWeight = 8");
    expect(source).toContain("filter.weight.uint8=kFwpmFilterWeight");
    expect(source).toContain("filter->weight.uint8!=kFwpmFilterWeight");
    expect(source).not.toContain("filter.weight.uint8=0x80");
  });
  it("uses one locale-independent SID JSON conversion at native fact boundaries", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("static std::string SidJsonText(const std::wstring& sid)");
    expect(source).toContain("SidJsonText(account.sid)");
    expect(source).not.toContain("std::string(account.sid.begin(),account.sid.end())");
  });
  it("normalizes and re-verifies owned filesystem security through retained handles", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("NormalizeOwnedSecurity(HANDLE object)");
    expect(source).toContain("SetSecurityInfo(object,SE_FILE_OBJECT");
    expect(source).toContain("GetSecurityInfo(object,SE_FILE_OBJECT");
    expect(source).toContain("GetSecurityDescriptorOwner");
    expect(source).toContain("GetSecurityDescriptorGroup");
    expect(source).toContain("GetSecurityDescriptorOwner(descriptor,&owner,&ownerDefaulted)");
    expect(source).toContain("GetSecurityDescriptorGroup(descriptor,&group,&groupDefaulted)");
    expect(source).not.toContain("GetSecurityDescriptorOwner(descriptor,&owner,nullptr)");
    expect(source).not.toContain("GetSecurityDescriptorGroup(descriptor,&group,nullptr)");
    expect(source).toContain("GetSecurityDescriptorSacl");
    expect(source).toContain("DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION");
    expect(source).toContain("SetSecurityInfo(object,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION");
    expect(source).toContain('ScopedPrivilege restorePrivilege(L"SeRestorePrivilege")');
    expect(source).not.toContain('ScopedPrivilege restorePrivilege(L"SeSecurityPrivilege")');
    expect(source).not.toContain('ScopedPrivilege restorePrivilege(L"SeRelabelPrivilege")');
    expect(source).toContain("TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY");
    expect(source).toContain("PrivilegeEnabled(token_,luid_)!=wasEnabled_");
    expect(source).toContain("PHASE_E_SECURITY_STATUS:%s:%s:%lu");
    expect(source).toContain('"PHASE_E_ACL_SET_FAILED:"');
    expect(source.match(/SecurityStatus\(objectName,/g)).toHaveLength(3);
    expect(source.match(/throw SecuritySetFailure\(/g)).toHaveLength(3);
    expect(source).toContain('SecurityStage(objectName,"owner-group:before-apply")');
    expect(source).toContain('SecurityStage(objectName,"dacl:before-apply")');
    expect(source).toContain('SecurityStage(objectName,"label:before-apply")');
    expect(source.indexOf('"owner-group:before-apply"')).toBeLessThan(
      source.indexOf('"dacl:before-apply"'),
    );
    expect(source.indexOf('"dacl:before-apply"')).toBeLessThan(
      source.indexOf('"label:before-apply"'),
    );
    expect(source).toContain("expectedOwner,expectedGroup,nullptr,nullptr");
    expect(source).toContain("nullptr,nullptr,expectedDacl,nullptr");
    expect(source).toContain("nullptr,nullptr,nullptr,expectedLabel");
    expect(source).toContain("CopySid(ownerLength,ownerBytes.data(),owner)");
    expect(source).toContain("IsValidAcl(dacl)");
    expect(source).toContain("EqualSid(expectedOwner,actualOwner)");
    expect(source).toContain("SameAcl(expectedDacl,actualDacl)");
    expect(source).toContain("SameAcl(expectedLabel,actualLabel)");
    expect(source).toContain("PHASE_E_SECURITY_STAGE:%s:%s");
    expect(source).toContain("fflush(stderr)");
    expect(source).toContain("SE_DACL_PROTECTED");
    expect(source).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(source).toContain("GENERIC_READ|GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER");
    expect(source).toContain("CreateFileW(path,kNormalizedFileAccess");
    expect(source).toContain("SetFileInformationByHandle(object,FileDispositionInfo");
  });
  it("records a non-reusable Windows process identity and bounded fault rollback", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("GetProcessTimes(GetCurrentProcess()");
    expect(source).toContain("PHASE_E_PROCESS_IDENTITY_FAILED");
    expect(source).toContain("FaultPoint::Account");
    expect(source).toContain("FaultPoint::Credential");
    expect(source).toContain("FaultPoint::RootStore");
    expect(source).toContain("FaultPoint::Fwpm");
    expect(source).toContain("FaultPoint::ProfileScratch");
    expect(source).toContain("EnsureProfilesAndScratch(accounts)");
    expect(source).toContain("NormalizeSlotSecurity");
    expect(source).toContain("CurrentUserSid()");
    expect(source).toContain("VerifyRecordedMaintainerDead(json)");
    expect(source).toContain("PHASE_E_STALE_PROCESS_IDENTITY");
    expect(source).toContain("HasPartialOwnedArtifacts()");
    expect(source).toContain("PHASE_E_PARTIAL_STATE_DETECTED");
    expect(source).toContain("VerifyPersistedStore(accounts)");
    expect(source).toContain("RemoveOwnedFwpm(accounts)");
    expect(source).not.toMatch(
      /CreateProcess|ShellExecute|WinExec|schtasks|powershell|cmd\.exe|netsh|CoCreateInstance/i,
    );
  });
  it("uses the system CSPRNG and wipes temporary credential memory in the native boundary", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../native/phase-e-maintainer.cc", import.meta.url), "utf8"),
    );
    expect(source).toContain("BCryptGenRandom(nullptr, random");
    expect(source).toContain("BCRYPT_USE_SYSTEM_PREFERRED_RNG");
    expect(source).toContain("class SecureWipe");
    expect(source).toContain("SecureWipe randomWipe");
    expect(source).toContain("SecureWipe passwordWipe");
    expect(source).not.toContain("CryptGenRandom(0");
  });
});
