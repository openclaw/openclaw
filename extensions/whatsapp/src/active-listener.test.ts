import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveWebListener,
  clearWebListenerRecovery,
  getActiveWebListener,
  requestWebListenerRecovery,
  setActiveWebListener,
  setWebListenerRecovery,
  type ActiveWebListener,
} from "./active-listener.js";

type ActiveListenerModule = typeof import("./active-listener.js");

const activeListenerModuleUrl = new URL("./active-listener.ts", import.meta.url).href;

async function importActiveListenerModule(cacheBust: string): Promise<ActiveListenerModule> {
  return (await import(`${activeListenerModuleUrl}?t=${cacheBust}`)) as ActiveListenerModule;
}

describe("active WhatsApp listener registry", () => {
  const listenerA: ActiveWebListener = {
    sendMessage: vi.fn(async () => ({ messageId: "a" })),
    sendPoll: vi.fn(async () => ({ messageId: "a" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
  const listenerB: ActiveWebListener = {
    sendMessage: vi.fn(async () => ({ messageId: "b" })),
    sendPoll: vi.fn(async () => ({ messageId: "b" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };

  afterEach(async () => {
    setActiveWebListener(null);
    setActiveWebListener("work", null);
    setWebListenerRecovery(null, null);
    setWebListenerRecovery("work", null);

    const mod = await importActiveListenerModule(`cleanup-${Date.now()}`);
    mod.setActiveWebListener(null);
    mod.setActiveWebListener("work", null);
    mod.setWebListenerRecovery?.(null, null);
    mod.setWebListenerRecovery?.("work", null);
  });

  it("shares listeners across duplicate module instances", async () => {
    const first = await importActiveListenerModule(`first-${Date.now()}`);
    const second = await importActiveListenerModule(`second-${Date.now()}`);
    const listener = {
      sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
      sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
      sendReaction: vi.fn(async () => {}),
      sendComposingTo: vi.fn(async () => {}),
    };

    first.setActiveWebListener("work", listener);

    expect(second.getActiveWebListener("work")).toBe(listener);
    expect(second.requireActiveWebListener("work")).toEqual({
      accountId: "work",
      listener,
    });
  });

  it("does not let a stale listener clear a newer listener", () => {
    setActiveWebListener("work", listenerA);
    setActiveWebListener("work", listenerB);

    expect(clearActiveWebListener("work", listenerA)).toBe(false);
    expect(getActiveWebListener("work")).toBe(listenerB);

    expect(clearActiveWebListener("work", listenerB)).toBe(true);
    expect(getActiveWebListener("work")).toBeNull();
  });

  it("does not let a stale recovery hook clear a newer recovery hook", async () => {
    const recoveryA = vi.fn(async () => true);
    const recoveryB = vi.fn(async () => true);

    setWebListenerRecovery("work", recoveryA);
    setWebListenerRecovery("work", recoveryB);

    expect(clearWebListenerRecovery("work", recoveryA)).toBe(false);
    await requestWebListenerRecovery("work", "probe");
    expect(recoveryA).not.toHaveBeenCalled();
    expect(recoveryB).toHaveBeenCalledWith({ accountId: "work", reason: "probe" });

    expect(clearWebListenerRecovery("work", recoveryB)).toBe(true);
    expect(await requestWebListenerRecovery("work", "probe-2")).toBe(false);
  });
});
