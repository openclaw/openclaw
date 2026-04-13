import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core interaction aborts", () => {
  it("disconnects the target when a click is aborted after it starts", async () => {
    const ctrl = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pendingClick = new Promise<void>(() => {});
    const click = vi.fn(() => {
      resolveStarted();
      return pendingClick;
    });

    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({
      url: vi.fn(() => "https://example.com"),
    });

    const promise = mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      signal: ctrl.signal,
    });

    await started;
    ctrl.abort(new Error("click aborted"));

    await expect(promise).rejects.toThrow("click aborted");
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
      }),
    );
  });
});
