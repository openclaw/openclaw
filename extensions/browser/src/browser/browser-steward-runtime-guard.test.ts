import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateBrowserStewardRuntimeGuard,
  isBrowserStewardSession,
  resolveBrowserStewardProxyAction,
} from "./browser-steward-runtime-guard.js";

describe("Browser Steward runtime guard", () => {
  it("recognizes Browser Steward session keys", () => {
    expect(isBrowserStewardSession("agent:browser-session-credential-steward:abc")).toBe(true);
    expect(isBrowserStewardSession("agent:main:abc")).toBe(false);
  });

  it("defaults sensitive mutation to approval_required", () => {
    expect(
      evaluateBrowserStewardRuntimeGuard({ action: "navigate", profile: "work" }),
    ).toMatchObject({
      boundaryDecision: "approval_required",
      approvalRequired: true,
      affectedBrowserProfile: "work",
      telemetryEvent: "browser_steward.approval_gate",
    });
  });

  it("allows read-only non-secret status", () => {
    expect(evaluateBrowserStewardRuntimeGuard({ action: "status" })).toMatchObject({
      boundaryDecision: "allow",
      approvalRequired: false,
      dataSensitivity: "low",
    });
  });

  it("maps browser proxy requests to Browser Steward actions", () => {
    expect(resolveBrowserStewardProxyAction({ method: "GET", path: "/" })).toBe("status");
    expect(resolveBrowserStewardProxyAction({ method: "GET", path: "/profiles" })).toBe("profiles");
    expect(resolveBrowserStewardProxyAction({ method: "POST", path: "/tabs/open" })).toBe("open");
    expect(resolveBrowserStewardProxyAction({ method: "POST", path: "/navigate" })).toBe(
      "navigate",
    );
    expect(resolveBrowserStewardProxyAction({ method: "POST", path: "/act" })).toBe("act");
    expect(resolveBrowserStewardProxyAction({ method: "DELETE", path: "/tabs/abc" })).toBe("close");
  });

  it("classifies secret-like input without returning the value", () => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "act",
      request: { kind: "type", text: "Bearer SHOULD_NOT_APPEAR" },
    });
    expect(decision).toMatchObject({
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(decision)).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("documents backup scope exclusions for browser/session sensitive state", () => {
    const denylist = readFileSync("control/docs/BACKUP_SCOPE_BROWSER_SESSION_DENYLIST.md", "utf8");
    for (const term of [
      "browser cache",
      "browser cookies",
      "local storage",
      "session storage",
      "auth tokens",
      "wallet state",
      "SSH private keys",
      "credential vault exports",
      "profile lock files",
      "authenticated exports",
    ]) {
      expect(denylist).toContain(term);
    }
  });
});
