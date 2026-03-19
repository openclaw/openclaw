import { afterEach, describe, expect, it, vi } from "vitest";

type ActiveListenerModule = typeof import("./active-listener.js");

const activeListenerModuleUrl = new URL("./active-listener.ts", import.meta.url).href;

async function importActiveListenerModule(cacheBust: string): Promise<ActiveListenerModule> {
  return (await import(`${activeListenerModuleUrl}?t=${cacheBust}`)) as ActiveListenerModule;
}

afterEach(async () => {
  const mod = await importActiveListenerModule(`cleanup-${Date.now()}`);
  mod.setActiveWebListener(null);
  mod.setActiveWebListener("work", null);
});

describe("active WhatsApp listener singleton", () => {
  it("shares listeners across duplicate module instances", async () => {
    const first = await importActiveListenerModule(`first-${Date.now()}`);
    const second = await importActiveListenerModule(`second-${Date.now()}`);
    const listener = {
      sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
      sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
      sendReaction: vi.fn(async () => {}),
      sendLocation: vi.fn(async () => ({ messageId: "loc-1" })),
      sendComposingTo: vi.fn(async () => {}),
    };

    first.setActiveWebListener("work", listener);

    expect(second.getActiveWebListener("work")).toBe(listener);
    expect(second.requireActiveWebListener("work")).toEqual({
      accountId: "work",
      listener,
    });
  });
});
