import { expect, it, vi } from "vitest";
import * as cdpHelpers from "./cdp.helpers.js";
import { captureScreenshot } from "./cdp.js";

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
