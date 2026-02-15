import { describe, expect, it } from "vitest";
import {
  buildHeartbeatAnnouncement,
  buildIsolatedHeartbeatPrompt,
  heartbeatNeedsAction,
  isHeartbeatSession,
  resolveHeartbeatIsolationConfig,
} from "./heartbeat-isolation.js";

describe("resolveHeartbeatIsolationConfig", () => {
  it("returns defaults when no config", () => {
    const config = resolveHeartbeatIsolationConfig();
    expect(config.isolated).toBe(true);
    expect(config.model).toBe("anthropic/claude-haiku");
    expect(config.maxTokens).toBe(2000);
  });

  it("respects explicit config", () => {
    const config = resolveHeartbeatIsolationConfig({
      agents: {
        defaults: {
          heartbeat: {
            isolated: false,
            model: "anthropic/claude-sonnet-4-5",
            maxTokens: 4000,
          },
        },
      },
    } as never);
    expect(config.isolated).toBe(false);
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.maxTokens).toBe(4000);
  });
});

describe("buildIsolatedHeartbeatPrompt", () => {
  it("includes heartbeat check description", () => {
    const prompt = buildIsolatedHeartbeatPrompt({});
    expect(prompt).toContain("heartbeat check");
    expect(prompt).toContain("isolated micro-session");
    expect(prompt).toContain("sessions_send");
  });

  it("includes HEARTBEAT.md content when provided", () => {
    const prompt = buildIsolatedHeartbeatPrompt({
      heartbeatMd: "Check for new emails every 30 minutes.",
    });
    expect(prompt).toContain("HEARTBEAT.md");
    expect(prompt).toContain("Check for new emails");
  });

  it("includes fallback message when no HEARTBEAT.md", () => {
    const prompt = buildIsolatedHeartbeatPrompt({});
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("includes context fields", () => {
    const prompt = buildIsolatedHeartbeatPrompt({
      agentId: "my-agent",
      workspaceDir: "/home/user/project",
      userTimezone: "America/New_York",
      currentTime: "2025-01-01 12:00",
    });
    expect(prompt).toContain("my-agent");
    expect(prompt).toContain("/home/user/project");
    expect(prompt).toContain("America/New_York");
    expect(prompt).toContain("2025-01-01 12:00");
  });

  it("does not include main session history", () => {
    const prompt = buildIsolatedHeartbeatPrompt({
      heartbeatMd: "Simple check",
    });
    // Verify minimal prompt - no skills, no history references
    expect(prompt).not.toContain("skills");
    expect(prompt.length).toBeLessThan(1000);
  });
});

describe("heartbeatNeedsAction", () => {
  it("returns false for HEARTBEAT_OK", () => {
    expect(heartbeatNeedsAction("HEARTBEAT_OK")).toBe(false);
  });

  it("returns false for HEARTBEAT_OK with short suffix", () => {
    expect(heartbeatNeedsAction("HEARTBEAT_OK - all clear")).toBe(false);
  });

  it("returns true for non-OK response", () => {
    expect(heartbeatNeedsAction("Found 3 new emails that need attention.")).toBe(true);
  });

  it("returns false for empty response", () => {
    expect(heartbeatNeedsAction("")).toBe(false);
    expect(heartbeatNeedsAction("   ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(heartbeatNeedsAction("heartbeat_ok")).toBe(false);
    expect(heartbeatNeedsAction("Heartbeat_OK")).toBe(false);
  });

  it("returns true when HEARTBEAT_OK has long suffix", () => {
    expect(
      heartbeatNeedsAction(
        "HEARTBEAT_OK but actually there are important updates that need your attention",
      ),
    ).toBe(true);
  });
});

describe("buildHeartbeatAnnouncement", () => {
  it("includes session key and response", () => {
    const announcement = buildHeartbeatAnnouncement({
      heartbeatResponse: "Found 3 new emails",
      sessionKey: "main",
    });
    expect(announcement).toContain("main");
    expect(announcement).toContain("Found 3 new emails");
    expect(announcement).toContain("Heartbeat action needed");
  });
});

describe("isHeartbeatSession", () => {
  it("identifies heartbeat sessions", () => {
    expect(isHeartbeatSession("agent:main:heartbeat")).toBe(true);
    expect(isHeartbeatSession("heartbeat:check")).toBe(true);
  });

  it("rejects non-heartbeat sessions", () => {
    expect(isHeartbeatSession("agent:main")).toBe(false);
    expect(isHeartbeatSession("cron:daily-check")).toBe(false);
  });
});
