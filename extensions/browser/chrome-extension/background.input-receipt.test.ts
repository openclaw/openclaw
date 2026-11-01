import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadRelayCommandHarness,
  sendRuntimeMessage,
} from "./background.test-harness.js";

for (const mode of ["all", "selected"] as const) {
  describe(`completed input receipts (${mode})`, () => {
    let h: Awaited<ReturnType<typeof loadRelayCommandHarness>>;
    const input = (method = "Input.dispatchMouseEvent") =>
      h.command({ type: "cdp", tabId: 7, method, params: { type: "mouseReleased" } });
    beforeEach(async () => {
      vi.resetModules();
      h = await loadRelayCommandHarness(mode);
      h.shareTab(7);
      expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
    });
    afterEach(async () => {
      await cleanupBackgroundHarnesses();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it.each(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"])(
      "acknowledges %s once after a same-URL history update",
      async (method) => {
        h.debuggerSendCommand.mockImplementationOnce(async () => {
          h.updateTab(7, { url: "https://example.com/tab/7" });
          return {};
        });
        expect(await input(method)).toMatchObject({ type: "result", result: {} });
        expect(h.debuggerSendCommand).toHaveBeenCalledTimes(1);
        // A subsequent document operation can use the renewed attachment.
        expect(
          await h.command({ type: "cdp", tabId: 7, method: "Runtime.evaluate" }),
        ).toMatchObject({ type: "result" });
      },
    );

    it("acknowledges completed input after an allowed navigation", async () => {
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(7, { url: "https://example.com/next" });
        return {};
      });
      expect(await input()).toMatchObject({ type: "result" });
    });

    it("still rejects stale document results", async () => {
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(7, { url: "https://example.com/tab/7" });
        return { result: { value: "stale" } };
      });
      expect(
        await h.command({ type: "cdp", tabId: 7, method: "Runtime.callFunctionOn" }),
      ).toMatchObject({ type: "error" });
    });

    it("rejects both queued inputs before dispatch after a document change", async () => {
      const gate = createDeferred<void>();
      const entered = createDeferred<void>();
      const getTab = h.tabsGet.getMockImplementation()!;
      h.tabsGet.mockImplementationOnce(async (id) => {
        entered.resolve();
        await gate.promise;
        return getTab(id);
      });
      const first = input();
      await entered.promise;
      const second = input("Input.dispatchKeyEvent");
      // A later independent command proves both Input frames reached the dispatcher.
      expect(await h.command({ type: "activateTab", tabId: 7 })).toMatchObject({ type: "result" });
      h.updateTab(7, { url: "https://example.com/tab/7" });
      gate.resolve();
      expect(await Promise.all([first, second])).toEqual([
        expect.objectContaining({ type: "error" }),
        expect.objectContaining({ type: "error" }),
      ]);
      expect(h.debuggerSendCommand).not.toHaveBeenCalled();
    });

    it.each(["sharing", "attachment", "restricted", "incognito"] as const)(
      "rejects completed input when %s authority is lost",
      async (change) => {
        h.debuggerSendCommand.mockImplementationOnce(async () => {
          if (change === "sharing") {
            if (mode === "all") {
              for (const grant of [false, true]) {
                expect(
                  await sendRuntimeMessage(h, {
                    type: "toggleTabAccess",
                    tabId: 7,
                    accessMode: mode,
                    grant,
                  }),
                ).toMatchObject({ ok: true });
              }
            } else {
              h.updateTab(7, { groupId: -1 });
              h.updateTab(7, { groupId: 7 });
            }
          } else if (change === "attachment") {
            expect(await h.command({ type: "detach", tabId: 7 })).toMatchObject({ type: "result" });
            expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
          } else if (change === "restricted") {
            h.updateTab(7, { url: "chrome://settings" });
          } else {
            h.updateTab(7, { incognito: true });
          }
          return {};
        });
        expect(await input()).toMatchObject({ type: "error" });
        expect(h.debuggerSendCommand).toHaveBeenCalledTimes(1);
      },
    );

    it("preserves a native dispatch failure", async () => {
      h.debuggerSendCommand.mockRejectedValueOnce(new Error("Native input failed"));
      expect(await input()).toMatchObject({ type: "error", message: "Native input failed" });
      expect(h.debuggerSendCommand).toHaveBeenCalledTimes(1);
    });
  });
}
