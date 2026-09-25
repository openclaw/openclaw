// Verifies runtime channel capabilities derived from channel account config.
import { describe, expect, it } from "vitest";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("collectRuntimeChannelCapabilities", () => {
  it("advertises markdown details for internal webchat", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "webchat" })).toEqual(["markdownDetails"]);
  });

  it("does not advertise markdown details for a plugin-less non-webchat channel", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "heartbeat" })).toBeUndefined();
  });

  it("never advertises thread-bound spawn capabilities", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: { session: { threadBindings: { enabled: true, spawnSessions: true } } },
    });

    expect(capabilities ?? []).not.toContain("threadbound-subagent-spawn");
    expect(capabilities ?? []).not.toContain("threadbound-acp-spawn");
  });
});
