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
    location: { href: "https://meet.google.com/abc-defg-hij", hostname: "meet.google.com", reload },
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

it.each([
  ["accounts.google.com", "Choose an account", true],
  ["accounts.google.com", "Choose an account", false],
  ["meet.google.com", "Sign in to join", true],
  ["meet.google.com", "Sign in to join", false],
] as const)("preserves Google login on %s (%s, autoJoin=%s)", async (host, pageText, autoJoin) => {
  const source = meetStatusScript({
    allowMicrophone: true,
    autoJoin,
    captionSessionId: "session-1",
    captureCaptions: false,
    guestName: "OpenClaw Agent",
  });
  const setTimeout = vi.fn();
  const setItem = vi.fn();
  const result = JSON.parse(
    String(
      await runInNewContext(`(${source})()`, {
        window: {},
        document: {
          body: { textContent: pageText },
          querySelector: () => null,
          querySelectorAll: () => [],
        },
        location: { href: `https://${host}/`, hostname: host },
        sessionStorage: { getItem: () => null, setItem },
        setTimeout,
      }),
    ),
  );
  expect(result).toMatchObject({
    inCall: false,
    clickedJoin: false,
    manualAction: { reason: "google-login-required" },
  });
  expect(setTimeout).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();
});
