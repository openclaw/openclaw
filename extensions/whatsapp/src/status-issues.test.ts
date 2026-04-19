import { describe, expect, it } from "vitest";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

describe("collectWhatsAppStatusIssues", () => {
  it("reports unlinked enabled accounts", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
      }),
    ]);
  });

  it("reports linked but disconnected runtime state", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "work",
        enabled: true,
        linked: true,
        running: true,
        connected: false,
        reconnectAttempts: 2,
        lastError: "socket closed",
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "work",
        kind: "runtime",
        message: "Linked but disconnected (reconnectAttempts=2): socket closed",
      }),
    ]);
  });

  it("reports linked but stale runtime state even while connected", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: true,
        running: true,
        connected: true,
        healthState: "stale",
        lastInboundAt: Date.now() - 2 * 60_000,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "runtime",
        message: expect.stringContaining("Linked but stale"),
      }),
    ]);
  });
  it("does not report a not-linked auth issue when linked state is unknown", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
      },
    ]);

    expect(issues).toEqual([]);
  });

  it("still reports runtime issues when linked state is unknown", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        healthState: "reconnecting",
        reconnectAttempts: 3,
        lastError: "auth queue timed out",
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "runtime",
        message: "Session reconnecting (reconnectAttempts=3): auth queue timed out",
      }),
    ]);
  });

  it("still reports logged-out auth issues when linked state is unknown", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        healthState: "logged-out",
        lastError: "401",
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
        message: "Session logged out: 401",
      }),
    ]);
  });
});
