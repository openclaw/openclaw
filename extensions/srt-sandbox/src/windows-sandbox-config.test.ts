// Unit tests for the Windows scope config + embedded program sources (S6).
// Pure logic only (no srt-win spawn), so these run on any host; the live
// enforcement matrix (per-scope isolation, NtCreateFile pin escape resistance,
// WFP deny, Job-Object reap) is proven on a real Windows ARM64 host.
import { describe, expect, it } from "vitest";
import { PIN_OWNER_POWERSHELL, buildWindowsPinOwnerInnerArgs } from "./windows-pin-owner-source.js";
import { deriveWindowsScopeIdentity } from "./windows-sandbox-config.js";
import { WINDOWS_WORKER_POWERSHELL, buildWindowsWorkerArgv } from "./windows-worker-source.js";

describe("deriveWindowsScopeIdentity", () => {
  it("is deterministic for the same scope key + index", () => {
    const a = deriveWindowsScopeIdentity("scope-A", 0, {});
    const b = deriveWindowsScopeIdentity("scope-A", 0, {});
    expect(a).toEqual(b);
  });

  it("gives distinct accounts, sublayers, and port ranges to distinct scopes", () => {
    const pool = { sandboxUsers: ["srt-a", "srt-b"] };
    const s0 = deriveWindowsScopeIdentity("scope-0", 0, pool);
    const s1 = deriveWindowsScopeIdentity("scope-1", 1, pool);
    expect(s0.sandboxUser).toBe("srt-a");
    expect(s1.sandboxUser).toBe("srt-b");
    expect(s0.sublayerGuid).not.toBe(s1.sublayerGuid);
    expect(s0.proxyPortRange).not.toEqual(s1.proxyPortRange);
    // Port ranges are disjoint (per-scope loopback PERMIT windows).
    expect(s0.proxyPortRange[1]).toBeLessThan(s1.proxyPortRange[0]);
  });

  it("honors the configured proxy port base", () => {
    const id = deriveWindowsScopeIdentity("scope-0", 0, { proxyPortBase: 51000 });
    expect(id.proxyPortRange[0]).toBe(51000);
    expect(id.proxyPortRange[1]).toBe(51009);
  });

  it("produces a well-formed WFP sublayer GUID", () => {
    const id = deriveWindowsScopeIdentity("scope-x", 3, {});
    expect(id.sublayerGuid).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-4a10-9a10-[0-9a-f]{12}\}$/);
  });
});

describe("embedded Windows program sources", () => {
  it("pin owner uses the NtCreateFile live-handle mechanism (design v8 §4)", () => {
    expect(PIN_OWNER_POWERSHELL).toContain("NtCreateFile");
    expect(PIN_OWNER_POWERSHELL).toContain("FILE_OPEN_REPARSE_POINT");
    expect(PIN_OWNER_POWERSHELL).toContain("RootDirectory");
    // rename must be handle-relative via the native call (Win32 wrapper rejects it).
    expect(PIN_OWNER_POWERSHELL).toContain("NtSetInformationFile");
  });

  it("buildWindowsPinOwnerInnerArgs round-trips the source through -EncodedCommand", () => {
    const argv = buildWindowsPinOwnerInnerArgs();
    expect(argv[0]).toBe("powershell.exe");
    expect(argv).toContain("-EncodedCommand");
    const encoded = argv.at(-1)!;
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toBe(PIN_OWNER_POWERSHELL);
  });

  it("worker owns a KILL_ON_JOB_CLOSE Job Object and watches the parent (AC-S6-4)", () => {
    expect(WINDOWS_WORKER_POWERSHELL).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(WINDOWS_WORKER_POWERSHELL).toContain("AssignProcessToJobObject");
    expect(WINDOWS_WORKER_POWERSHELL).toContain("WatchParent");
  });

  it("buildWindowsWorkerArgv round-trips the worker source through -EncodedCommand", () => {
    const argv = buildWindowsWorkerArgv();
    expect(argv[0]).toBe("powershell.exe");
    expect(argv).toContain("-EncodedCommand");
    const encoded = argv.at(-1)!;
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toBe(WINDOWS_WORKER_POWERSHELL);
  });
});
