import { describe, expect, it, vi } from "vitest";
import * as cdpHelpers from "./cdp.helpers.js";
import { captureScreenshot } from "./cdp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { shouldUsePlaywrightForScreenshot } from "./profile-capabilities.js";

const localProfile: ResolvedBrowserProfile = {
  name: "openclaw",
  cdpUrl: "http://127.0.0.1:18800",
  cdpPort: 18800,
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  driver: "openclaw",
  headless: false,
  attachOnly: false,
};

describe("shouldUsePlaywrightForScreenshot routing", () => {
  it.each([
    { options: { wsUrl: "ws://x" }, expected: false },
    { options: {}, expected: true },
    { options: { wsUrl: "ws://x", ref: "btn-1" }, expected: true },
    { options: { wsUrl: "ws://x", element: "#submit" }, expected: true },
  ])("routes $options to Playwright: $expected", ({ options, expected }) => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile, ...options })).toBe(expected);
  });
});

// Regression: 3a7ee209c96 passed the screenshot budget into the command owner.
it("passes the requested screenshot timeout to the CDP transport", async () => {
  const socket = vi.spyOn(cdpHelpers, "withCdpSocket").mockResolvedValueOnce(Buffer.alloc(0));
  try {
    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X", timeoutMs: 12_345 });
    expect(socket).toHaveBeenCalledWith(
      "ws://localhost:9222/devtools/page/X",
      expect.any(Function),
      { commandTimeoutMs: 12_345, lookup: undefined },
    );
  } finally {
    socket.mockRestore();
  }
});
