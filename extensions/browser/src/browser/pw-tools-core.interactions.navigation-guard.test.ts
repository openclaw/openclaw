import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core interaction navigation guard", () => {
  it("runs the post-click navigation guard with the resolved SSRF policy", async () => {
    const click = vi.fn(async () => {});
    const page = { url: vi.fn(() => "http://127.0.0.1:9222/json/version") };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    const blocked = new Error("blocked interaction navigation");
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(blocked);

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toThrow("blocked interaction navigation");

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs the post-evaluate navigation guard after page evaluation", async () => {
    const page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "() => location.href = 'http://127.0.0.1:9222/json/version'",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("propagates the SSRF policy through batch interaction actions", async () => {
    const click = vi.fn(async () => {});
    const page = { url: vi.fn(() => "about:blank") };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ssrfPolicy: { allowPrivateNetwork: false },
      actions: [{ kind: "click", ref: "1" }],
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });
});
