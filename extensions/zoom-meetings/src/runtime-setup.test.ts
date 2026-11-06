import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import { zoomMeetingsPlugin } from "../index.js";

describe("Zoom meetings runtime setup", () => {
  it("accepts fresh-tab launch when existing-tab reuse is disabled", async () => {
    const status = await zoomMeetingsPlugin.setupStatus({
      config: zoomMeetingsPlugin.config.resolveConfig({
        defaultMode: "transcribe",
        chrome: { launch: true, reuseExistingTab: false },
      }),
      fullConfig: {},
      runtime: createTestPluginApi().runtime,
      options: { mode: "transcribe", transport: "chrome" },
    });
    expect(status.checks).toContainEqual({
      id: "guest-join",
      message: "Guest name, auto-join, and a Chrome launch or reuse path are configured",
      ok: true,
    });
    expect(status.ok).toBe(true);
  });
});
