import { describe, expect, it } from "vitest";
import { formatChromeMcpAttachFailureMessage } from "./chrome-mcp.js";

describe("chrome-mcp attach failure message", () => {
  it("adds actionable guidance for DevToolsActivePort failures", () => {
    const msg = formatChromeMcpAttachFailureMessage({
      profileName: "chrome-live",
      userDataDir: "/home/user/.config/google-chrome",
      details:
        "Could not connect to Chrome / missing DevToolsActivePort at /home/user/.config/google-chrome/DevToolsActivePort",
    });

    expect(msg).toContain("DevToolsActivePort");
    expect(msg).toContain("remote debugging");
    expect(msg).toContain("--remote-debugging-port=9222");
  });

  it("keeps generic details for unrelated failures", () => {
    const msg = formatChromeMcpAttachFailureMessage({
      profileName: "chrome-live",
      details: "attach failed",
    });

    expect(msg).toContain("attach failed");
    expect(msg).not.toContain("DevToolsActivePort missing");
  });
});
