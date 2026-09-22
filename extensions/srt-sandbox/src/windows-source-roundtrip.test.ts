// Round-trip guards for the embedded Windows PowerShell program sources (S6).
//
// These pin the RUNTIME form of the exact committed exported constants
// (PIN_OWNER_POWERSHELL / WINDOWS_WORKER_POWERSHELL) — not a hand-patched
// guest-side copy. A prior revision embedded the (correctly double-escaped)
// program bodies inside `String.raw`, which leaves every backslash DOUBLED at
// runtime; that broke NtCreateFile path resolution (STATUS_OBJECT_NAME_INVALID
// from `\\??\\…` instead of `\??\…`) and Quote-Arg's `[char]` compares (a
// two-char `'\\'` string where PowerShell expects a `System.Char`). The bodies
// are now plain template literals, so the runtime carries SINGLE backslashes.
// These assertions fail closed if anyone re-wraps them in String.raw.
import { describe, expect, it } from "vitest";
import { PIN_OWNER_POWERSHELL } from "./windows-pin-owner-source.js";
import { WINDOWS_WORKER_POWERSHELL } from "./windows-worker-source.js";

describe("pin-owner PowerShell runtime escaping", () => {
  it("uses single-backslash NT device paths (\\??\\), never doubled", () => {
    // The correct NT path prefix and normalizer forms (single backslashes).
    expect(PIN_OWNER_POWERSHELL).toContain("return '\\??\\' + $p");
    expect(PIN_OWNER_POWERSHELL).toContain("return '\\??\\UNC\\' + $p.Substring(2)");
    expect(PIN_OWNER_POWERSHELL).toContain("-replace '/', '\\'");
    // The String.raw regression would produce these doubled forms.
    expect(PIN_OWNER_POWERSHELL).not.toContain("'\\\\??\\\\'");
    expect(PIN_OWNER_POWERSHELL).not.toContain("-replace '/', '\\\\'");
  });

  it("splits path segments on a [\\/]+ regex (one literal backslash escape)", () => {
    // Regex char class matching '\' or '/': exactly one '\\' escape, not '\\\\'.
    expect(PIN_OWNER_POWERSHELL).toContain("-split '[\\\\/]+'");
    expect(PIN_OWNER_POWERSHELL).not.toContain("-split '[\\\\\\\\/]+'");
  });
});

describe("worker PowerShell runtime escaping", () => {
  it("Quote-Arg compares against a single backslash CHAR, not a 2-char string", () => {
    expect(WINDOWS_WORKER_POWERSHELL).toContain("$a[$i] -eq '\\'");
    expect(WINDOWS_WORKER_POWERSHELL).toContain("[void]$sb.Append('\\', $bs)");
    // The String.raw regression passes a 2-char '\\' where a System.Char is required.
    expect(WINDOWS_WORKER_POWERSHELL).not.toContain("$a[$i] -eq '\\\\'");
    expect(WINDOWS_WORKER_POWERSHELL).not.toContain("[void]$sb.Append('\\\\',");
  });

  it("Quote-Arg's whitespace regex uses real escape sequences (\\t\\n\\v)", () => {
    expect(WINDOWS_WORKER_POWERSHELL).toContain("-notmatch '[ \\t\\n\\v\"]'");
    expect(WINDOWS_WORKER_POWERSHELL).not.toContain("-notmatch '[ \\\\t\\\\n\\\\v\"]'");
  });
});

describe("no String.raw doubling regression", () => {
  it("neither program contains a doubled NT-path backslash run", () => {
    // `\\\\??\\\\` (four backslashes around ??) is the tell-tale String.raw form.
    expect(PIN_OWNER_POWERSHELL.includes("\\\\??\\\\")).toBe(false);
    expect(WINDOWS_WORKER_POWERSHELL.includes("\\\\??\\\\")).toBe(false);
  });
});
