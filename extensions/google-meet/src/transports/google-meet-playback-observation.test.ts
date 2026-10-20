import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";

it("reloads an unobserved pre-join document at most once", async () => {
  const source = meetStatusScript({
    allowMicrophone: true,
    autoJoin: true,
    captionSessionId: "session-1",
    captureCaptions: false,
    guestName: "OpenClaw Agent",
  });
  const stored = new Map<string, string>();
  const reload = vi.fn();
  const timers: (() => void)[] = [];
  const scope = {
    window: {},
    document: { querySelectorAll: () => [{ getAttribute: () => "Join now" }] },
    location: { href: "https://meet.google.com/abc-defg-hij", reload },
    sessionStorage: {
      getItem: (key: string) => stored.get(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    setTimeout: (callback: () => void) => timers.push(callback),
  };
  const first = JSON.parse(String(await runInNewContext(`(${source})()`, scope)));
  expect(first.inCall).toBe(false);
  expect(first.manualAction).toBeUndefined();
  expect(timers).toHaveLength(1);
  for (const callback of timers) {
    callback();
  }
  expect(reload).toHaveBeenCalledOnce();
  const second = JSON.parse(String(await runInNewContext(`(${source})()`, scope)));
  expect(second.manualAction.reason).toBe("meet-playback-observer-required");
  expect(timers).toHaveLength(1);
});
