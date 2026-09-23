import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const actions = await import("./pw-tools-core.interactions.actions.js");
const { waitForViaPlaywright } = await import("./pw-tools-core.interactions.content.js");
const { resizeViewportViaPlaywright } = await import("./pw-tools-core.snapshot.js");

describe("resident interaction authority", () => {
  it.each(["click", "type", "fill", "wait", "resize"] as const)(
    "starts each %s effect in the same turn as its final assertion",
    async (kind) => {
      const events: string[] = [];
      const effect = vi.fn(async () => {
        expect(events.at(-1)).toBe("assert");
        events.push("effect");
      });
      setPwToolsCoreCurrentRefLocator({ click: effect, fill: effect, press: effect });
      setPwToolsCoreCurrentPage({
        setViewportSize: effect,
        evaluateHandle: async () => {
          await effect();
          return { dispose: async () => {} };
        },
        waitForFunction: effect,
      });
      const opts = {
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        assertCurrent: () => {
          events.push("assert");
          queueMicrotask(() => events.push("yield"));
        },
      };
      switch (kind) {
        case "click":
          await actions.clickViaPlaywright({ ...opts, ref: "1" });
          break;
        case "type":
          await actions.typeViaPlaywright({ ...opts, ref: "1", text: "review", submit: true });
          break;
        case "fill":
          await actions.fillFormViaPlaywright({
            ...opts,
            fields: [
              { ref: "1", type: "text", value: "first" },
              { ref: "2", type: "text", value: "second" },
            ],
          });
          break;
        case "wait":
          await waitForViaPlaywright({ ...opts, fn: "() => true" });
          break;
        case "resize":
          await resizeViewportViaPlaywright({ ...opts, width: 800, height: 600 });
          break;
      }
      expect(effect).toHaveBeenCalledTimes(kind === "click" || kind === "resize" ? 1 : 2);
    },
  );

  it("still awaits an asynchronous authority and preserves its rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const admission = Promise.withResolvers<void>();
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({});
    setPwToolsCoreCurrentRefLocator({ click });
    const pending = actions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      assertCurrent: () => {
        entered.resolve();
        return admission.promise;
      },
    });
    const rejected = expect(pending).rejects.toThrow("actor revoked");
    await entered.promise;
    expect(click).not.toHaveBeenCalled();
    admission.reject(new Error("actor revoked"));
    await rejected;
    expect(click).not.toHaveBeenCalled();
  });

  it("rechecks resize authority after clearing the previous metrics owner", async () => {
    let current = true;
    const send = vi.fn(async () => {
      current = false;
    });
    const setViewportSize = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({ setViewportSize });
    Object.assign(getPwToolsCoreSessionMocks().ensurePageState(), {
      emulation: {
        metricsOwner: { viewport: { width: 400, height: 300 }, session: { send } },
      },
    });
    await expect(
      resizeViewportViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        width: 800,
        height: 600,
        assertCurrent: () => {
          if (!current) {
            throw new Error("actor revoked");
          }
        },
      }),
    ).rejects.toThrow("actor revoked");
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(setViewportSize).not.toHaveBeenCalled();
  });
});
