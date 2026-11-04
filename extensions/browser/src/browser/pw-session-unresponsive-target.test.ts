import { describe, expect, it } from "vitest";
import {
  setupPwSessionConnectionTest,
  UnresponsiveCdpTargetError,
} from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, pwAi } = setupPwSessionConnectionTest();
const { listPagesViaPlaywright } = pwAi;

describe("pw-session cold connection diagnostics", () => {
  it("does not retry after identifying an unresponsive target", async () => {
    connectOverCdpSpy.mockRejectedValue(new UnresponsiveCdpTargetError(["STALLED-PAGE"]));
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" })).rejects.toThrow(
      "STALLED-PAGE",
    );

    expect(connectOverCdpSpy).toHaveBeenCalledOnce();
  });
});
