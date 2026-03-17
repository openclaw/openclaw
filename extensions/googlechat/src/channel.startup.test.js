import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle
} from "../../test-utils/start-account-lifecycle.js";
const hoisted = vi.hoisted(() => ({
  startGoogleChatMonitor: vi.fn()
}));
vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual("./monitor.js");
  return {
    ...actual,
    startGoogleChatMonitor: hoisted.startGoogleChatMonitor
  };
});
import { googlechatPlugin } from "./channel.js";
describe("googlechatPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  it("keeps startAccount pending until abort, then unregisters", async () => {
    const unregister = vi.fn();
    hoisted.startGoogleChatMonitor.mockResolvedValue(unregister);
    const account = {
      accountId: "default",
      enabled: true,
      credentialSource: "inline",
      credentials: {},
      config: {
        webhookPath: "/googlechat",
        webhookUrl: "https://example.com/googlechat",
        audienceType: "app-url",
        audience: "https://example.com/googlechat"
      }
    };
    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: googlechatPlugin.gateway.startAccount,
      account
    });
    await expectPendingUntilAbort({
      waitForStarted: () => vi.waitFor(() => {
        expect(hoisted.startGoogleChatMonitor).toHaveBeenCalledOnce();
      }),
      isSettled,
      abort,
      task,
      assertBeforeAbort: () => {
        expect(unregister).not.toHaveBeenCalled();
      },
      assertAfterAbort: () => {
        expect(unregister).toHaveBeenCalledOnce();
      }
    });
    expect(patches.some((entry) => entry.running === true)).toBe(true);
    expect(patches.some((entry) => entry.running === false)).toBe(true);
  });
});
