import "./browser-tool.test-support.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";

const {
  browserActionsMocks,
  browserClientMocks,
  browserConfigMocks,
  sessionTabRegistryMocks,
  registerBrowserToolAfterEachReset,
} = await import("./browser-tool.test-support.js");

describe("browser tool tab persistence", () => {
  registerBrowserToolAfterEachReset();
  beforeEach(() => {
    browserConfigMocks.resolveBrowserConfig.mockReturnValue({
      enabled: true,
      controlPort: 18791,
      profiles: { user: { driver: "existing-session", attachOnly: true, color: "#00AA00" } },
      defaultProfile: "openclaw",
      actionTimeoutMs: 60_000,
    });
  });

  it("propagates async activity failure without retrying the completed action", async () => {
    const trackingError = new Error("404: tab not found");
    sessionTabRegistryMocks.touchSessionBrowserTab.mockRejectedValueOnce(trackingError);
    browserActionsMocks.browserAct.mockResolvedValueOnce({ ok: true, targetId: "current-tab" });
    const tool = createBrowserTool({ agentSessionKey: "agent:main:main" });

    await expect(
      tool.execute("call-1", {
        action: "act",
        profile: "user",
        request: { kind: "wait", targetId: "current-tab", timeMs: 1 },
      }),
    ).rejects.toBe(trackingError);

    expect(browserActionsMocks.browserAct).toHaveBeenCalledOnce();
    expect(browserClientMocks.browserTabs).not.toHaveBeenCalled();
  });
});
