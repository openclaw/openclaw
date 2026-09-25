import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { meetRuntime, MEET_URL } from "./test-support/fixtures.test-helpers.js";
import * as chromeTransport from "./transports/chrome.js";

describe("Google Meet failed-session tab adoption", () => {
  const state = useMeetingTestState(createOpenClawTestState);

  it("does not close an adopted tab when the failed session retries leave", async () => {
    const adoptionStarted = createDeferred<void>();
    const adoption = createDeferred<Awaited<ReturnType<typeof chromeTransport.launchChromeMeet>>>();
    const liveTabs = new Set<string>();
    let donorAttempts = 0;
    let allowAdoptedLeave = false;
    const launch = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockImplementationOnce(async () => {
        liveTabs.add("donor-tab");
        return {
          launched: true,
          tab: { targetId: "donor-tab", openedByPlugin: true },
          browser: { inCall: true, micMuted: true },
        };
      })
      .mockImplementationOnce(async () => {
        liveTabs.add("adopted-tab");
        return {
          launched: true,
          tab: { targetId: "adopted-tab", openedByPlugin: true },
          browser: { inCall: true, micMuted: true },
        };
      })
      .mockImplementationOnce(async () => {
        adoptionStarted.resolve();
        return await adoption.promise;
      });
    const leave = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockImplementation(async ({ tab }) => {
        const left = tab.targetId === "donor-tab" ? ++donorAttempts > 1 : allowAdoptedLeave;
        if (left) {
          liveTabs.delete(tab.targetId);
        }
        return { left, note: left ? "left" : "browser leave failed" };
      });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const runtime = state.track(
      meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        logger,
        { transcripts: { enabled: false } },
      ),
      { readWarnings: () => logger.warn.mock.calls },
    );
    let replacing: ReturnType<typeof runtime.join> | undefined;
    let retrying: ReturnType<typeof runtime.leave> | undefined;
    const adoptedResult = {
      launched: true,
      tab: { targetId: "adopted-tab", openedByPlugin: false },
      browser: { inCall: true, micMuted: true },
    };
    try {
      await runtime.join({ url: MEET_URL, agentId: "donor" });
      await expect(runtime.join({ url: MEET_URL, agentId: "failed" })).rejects.toThrow(
        "Could not leave the previous Meet browser tab before reassignment.",
      );
      const failed = runtime.list().find((session) => session.agentId === "failed");
      expect(failed?.state).toBe("ended");
      expect(failed?.chrome?.browserTab?.targetId).toBe("adopted-tab");
      if (!failed) {
        throw new Error("Expected a retained failed session");
      }
      replacing = runtime.join({ url: MEET_URL, agentId: "replacement" });
      await Promise.race([adoptionStarted.promise, replacing]);
      const callsBeforeRetry = leave.mock.calls.length;
      retrying = runtime.leave(failed.id);
      adoption.resolve(adoptedResult);
      const [replacement] = await Promise.all([replacing, retrying]);
      expect(replacement.session.chrome?.browserTab).toEqual({
        targetId: "adopted-tab",
        openedByPlugin: true,
      });
      expect(leave).toHaveBeenCalledTimes(callsBeforeRetry);
      expect(liveTabs).toEqual(new Set(["adopted-tab"]));
      expect(runtime.list().some((session) => session.id === failed.id)).toBe(false);
      allowAdoptedLeave = true;
      await runtime.leave(replacement.session.id);
      expect(leave).toHaveBeenLastCalledWith(
        expect.objectContaining({
          meetingSessionId: replacement.session.id,
          tab: { targetId: "adopted-tab", openedByPlugin: true },
        }),
      );
      expect(liveTabs.size).toBe(0);
    } finally {
      adoption.resolve(adoptedResult);
      await Promise.allSettled([replacing, retrying]);
      allowAdoptedLeave = true;
      for (const session of runtime.list()) {
        await runtime.leave(session.id);
      }
      leave.mockRestore();
      launch.mockRestore();
    }
  });
});
