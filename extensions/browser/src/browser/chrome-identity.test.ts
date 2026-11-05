import { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { launchChromeWithNativeIdentity } from "./chrome-identity.js";
import type { RunningChrome } from "./chrome.js";

afterEach(() => vi.unstubAllGlobals());

function runningChrome(): RunningChrome {
  return {
    pid: 4242,
    exe: { kind: "chromium", path: "/synthetic/chromium" },
    userDataDir: "/synthetic/profile",
    cdpPort: 9222,
    proc: new ChildProcess(),
  };
}

it("retains the owned browser if its native identity cannot be read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection closed");
    }),
  );
  const running = runningChrome();
  const launch = vi.fn(async () => running);
  const stop = vi.fn(async () => {});
  expect(
    await launchChromeWithNativeIdentity({
      cdpUrl: "http://127.0.0.1:9222",
      headless: true,
      extraArgs: [],
      launch,
      stop,
    }),
  ).toBe(running);
  expect(launch).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});

it("cleans up its exact owned browser when the identity read is cancelled", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancel browser startup");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      controller.abort(cancellation);
      throw cancellation;
    }),
  );
  const running = runningChrome();
  const launch = vi.fn(async () => running);
  const stop = vi.fn(async () => {});
  await expect(
    launchChromeWithNativeIdentity({
      cdpUrl: "http://127.0.0.1:9222",
      headless: true,
      extraArgs: [],
      signal: controller.signal,
      launch,
      stop,
    }),
  ).rejects.toBe(cancellation);
  expect(launch).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledExactlyOnceWith(running);
});
