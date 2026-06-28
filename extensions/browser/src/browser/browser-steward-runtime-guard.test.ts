import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateBrowserStewardRuntimeGuard,
  isBrowserStewardSession,
  shouldApplyBrowserStewardRuntimeGuard,
  resolveBrowserStewardSessionBoundary,
  resolveBrowserStewardProxyAction,
} from "./browser-steward-runtime-guard.js";

type BrowserStewardBoundaryFixture = {
  name: string;
  sessionKey?: string | null;
  browserExpected?: {
    kind: "browser_steward" | "other_agent" | "unscoped" | "unknown";
    ownerAgentId: string;
    affectedSession: string;
  };
  rawMustNotContain?: string[];
};

type CredentialStewardFixture = {
  name: string;
  value?: unknown;
  labels?: string[];
  expected: {
    exposureKind: "none" | "credential_like" | "credential_material";
    credentialClassesInvolved: string[];
    dataSensitivity: "low" | "medium" | "critical";
    blocked: boolean;
    reasonCode: "no_credential_material" | "credential_like_label" | "credential_material_detected";
    redactedSummary: string;
  };
  rawMustNotContain?: string[];
};

const boundaryFixtures = JSON.parse(
  readFileSync("test/fixtures/session-steward-boundary-cases.json", "utf8"),
) as BrowserStewardBoundaryFixture[];
const credentialFixtures = JSON.parse(
  readFileSync("test/fixtures/credential-steward-redaction-cases.json", "utf8"),
) as CredentialStewardFixture[];
const browserBoundaryFixtures = boundaryFixtures.filter(
  (
    fixture,
  ): fixture is BrowserStewardBoundaryFixture & {
    browserExpected: NonNullable<BrowserStewardBoundaryFixture["browserExpected"]>;
  } => fixture.browserExpected !== undefined,
);

describe("Browser Steward runtime guard", () => {
  it("recognizes only exact Browser Steward agent session keys", () => {
    expect(isBrowserStewardSession("agent:browser-session-credential-steward:abc")).toBe(true);
    expect(isBrowserStewardSession("agent:browser-session-credential-steward")).toBe(true);
    expect(isBrowserStewardSession("Agent:Browser-Session-Credential-Steward:Main")).toBe(true);
    expect(isBrowserStewardSession("agent:main:abc")).toBe(false);
    expect(isBrowserStewardSession("agent:not-browser-session-credential-steward:main")).toBe(
      false,
    );
    expect(isBrowserStewardSession("agent:browser-session-credential-stewardish:main")).toBe(false);
    expect(isBrowserStewardSession("agent:main:browser-session-credential-steward")).toBe(false);
    expect(isBrowserStewardSession("agent:browser-session-credential-steward:")).toBe(false);
    expect(isBrowserStewardSession("browser-session-credential-steward")).toBe(false);
  });

  it("enables the guard for Browser Steward global sessions by agent id", () => {
    expect(
      shouldApplyBrowserStewardRuntimeGuard({
        sessionKey: "global",
        agentId: "browser-session-credential-steward",
      }),
    ).toBe(true);
    expect(
      shouldApplyBrowserStewardRuntimeGuard({
        sessionKey: "global",
        agentId: "main",
      }),
    ).toBe(false);
  });

  it.each(browserBoundaryFixtures)("matches shared boundary fixture: $name", (fixture) => {
    const boundary = resolveBrowserStewardSessionBoundary(fixture.sessionKey ?? undefined);
    expect(boundary).toEqual(fixture.browserExpected);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(boundary)).not.toContain(rawValue);
    }
  });

  it("defaults sensitive mutation to approval_required", () => {
    expect(
      evaluateBrowserStewardRuntimeGuard({
        action: "navigate",
        profile: "work",
        agentSessionKey: "agent:main:direct:person-123",
      }),
    ).toMatchObject({
      boundaryDecision: "approval_required",
      approvalRequired: true,
      affectedBrowserProfile: "work",
      affectedSession: "agent:main:REDACTED",
      sessionBoundary: {
        kind: "other_agent",
        ownerAgentId: "main",
        affectedSession: "agent:main:REDACTED",
      },
      telemetryEvent: "browser_steward.approval_gate",
    });
    expect(
      JSON.stringify(
        evaluateBrowserStewardRuntimeGuard({
          action: "navigate",
          profile: "work",
          agentSessionKey: "agent:main:direct:person-123",
        }),
      ),
    ).not.toContain("person-123");
  });

  it("redacts untrusted credential-like action strings in decisions", () => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "Bearer SHOULD_NOT_APPEAR",
      agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
    });

    expect(decision).toMatchObject({
      requestedAction: "unknown",
      credentialExposureKind: "credential_material",
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(decision)).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("allows approved Browser Steward mutations with redacted session metadata", () => {
    expect(
      evaluateBrowserStewardRuntimeGuard({
        action: "open",
        approved: true,
        agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      }),
    ).toMatchObject({
      boundaryDecision: "allow",
      affectedSession: "agent:browser-session-credential-steward:REDACTED",
      sessionBoundary: {
        kind: "browser_steward",
        ownerAgentId: "browser-session-credential-steward",
      },
    });
  });

  it("marks missing sessions as unknown", () => {
    expect(evaluateBrowserStewardRuntimeGuard({ action: "status" })).toMatchObject({
      affectedSession: "UNKNOWN",
      sessionBoundary: {
        kind: "unknown",
        ownerAgentId: "UNKNOWN",
      },
    });
  });

  it("allows read-only non-secret status", () => {
    expect(evaluateBrowserStewardRuntimeGuard({ action: "status" })).toMatchObject({
      boundaryDecision: "allow",
      approvalRequired: false,
      dataSensitivity: "low",
      credentialExposureKind: "none",
      credentialExposureReasonCode: "no_credential_material",
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
      credentialExposureKind: "credential_material",
      credentialExposureReasonCode: "credential_material_detected",
      dataSensitivity: "critical",
    });
    expect(JSON.stringify(decision)).not.toContain("SHOULD_NOT_APPEAR");
  });

  it.each(credentialFixtures)("matches shared credential fixture: $name", (fixture) => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "status",
      request: {
        ...(fixture.labels ? { labels: fixture.labels } : {}),
        value: fixture.value,
      },
    });

    expect(decision).toMatchObject({
      credentialExposureKind: fixture.expected.exposureKind,
      credentialExposureReasonCode: fixture.expected.reasonCode,
      dataSensitivity: fixture.expected.blocked ? "critical" : "low",
      approvalRequired: fixture.expected.blocked,
      telemetryEvent: fixture.expected.blocked
        ? "browser_steward.blocked_credential_exposure"
        : "browser_steward.boundary_decision",
    });
    expect(decision.credentialClassesInvolved).toEqual([
      "browser session",
      ...fixture.expected.credentialClassesInvolved,
    ]);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(decision)).not.toContain(rawValue);
    }
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
