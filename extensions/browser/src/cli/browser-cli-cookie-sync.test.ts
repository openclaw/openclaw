import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import { createBrowserProgram } from "./browser-cli.test-support.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
const { push, watch, readCookies } = vi.hoisted(() => ({
  push: vi.fn(async () => ({ ok: true, targetId: "tab-1", added: 1 })),
  watch: vi.fn(),
  readCookies: vi.fn<typeof import("../browser/system-profiles.js").readSystemProfileCookies>(
    async () => ({
      browser: "chrome" as const,
      systemProfile: "Default",
      cookies: [
        {
          name: "session",
          value: "cookie-secret",
          domain: ".example.com",
          path: "/",
          httpOnly: true,
          secure: true,
        },
      ],
      counts: { total: 2, imported: 1, failed: 0, skipped: 1 },
      domains: [".example.com"],
    }),
  ),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, watch } };
});
vi.mock("../browser/system-chrome-cookies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/system-chrome-cookies.js")>()),
  cacheKeychainSecret: vi.fn(async () => vi.fn()),
}));
vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(push);

vi.mock("../browser/system-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/system-profiles.js")>()),
  assertSystemCookiePlatform: vi.fn(),
  readSystemProfileCookies: readCookies,
  resolveSystemCookieSource: vi.fn(async () => ({
    browser: "chrome",
    cookiesFile: "/synthetic/Cookies",
  })),
}));

vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);

const { registerBrowserCookieSyncCommand } = await import("./browser-cli-cookie-sync.js");
const receipt = { ok: true, targetId: "tab-1", added: 1 };

function run(...args: (string | string[])[]) {
  const { program, browser, parentOpts } = createBrowserProgram({ withGatewayUrl: true });
  browser.option("--token <token>", "Gateway token").option("--timeout <ms>", "Timeout", "30000");
  registerBrowserCookieSyncCommand(browser, parentOpts);
  return program.parseAsync(["browser", ...args.flat()], { from: "user" });
}

describe("browser cookie-sync CLI", () => {
  beforeEach(() => {
    resetRuntimeCapture();
    push.mockClear();
    readCookies.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("resyncs changes received during a pending push and settles on stop", async () => {
    vi.useFakeTimers();
    const firstPush = createDeferred<typeof receipt>();
    const secondPush = createDeferred<typeof receipt>();
    push.mockImplementationOnce(async () => firstPush.promise);
    push.mockImplementationOnce(async () => secondPush.promise);
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    let changed: (event: string, filename: string) => void = () => {};
    watch.mockImplementation((_path, listener) => {
      changed = listener;
      return watcher;
    });
    const running = run("cookie-sync", "--domains", "example.com", "--watch");
    try {
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
      changed("change", "Cookies-wal");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(push).toHaveBeenCalledTimes(1);
      firstPush.resolve(receipt);
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
      changed("change", "Cookies");
      await vi.advanceTimersByTimeAsync(1_500);
      process.emit("SIGINT");
      secondPush.resolve(receipt);
      await running;
      expect(readCookies).toHaveBeenCalledTimes(2);
      expect(watcher.close).toHaveBeenCalledOnce();
    } finally {
      process.emit("SIGINT");
      firstPush.resolve(receipt);
      secondPush.resolve(receipt);
      await running;
    }
  });

  it("requires a non-empty domain allowlist before any read or gateway call", async () => {
    await expect(run("cookie-sync")).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("--domains is required");
    expect(readCookies).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("reads allowlisted cookies locally and posts them through browser.request", async () => {
    await run(
      ["--url", "wss://gateway.example"],
      ["--token", "test-token"],
      "cookie-sync",
      ["--domains", "example.com, accounts.example.com"],
      ["--into", "work"],
      ["--browser", "chrome"],
      ["--system", "Profile 1"],
    );

    expect(readCookies.mock.calls[0]?.[0]).toMatchObject({
      browser: "chrome",
      systemProfile: "Profile 1",
      domains: ["example.com", "accounts.example.com"],
    });
    expect(push.mock.calls[0]).toMatchObject([
      "browser.request",
      { url: "wss://gateway.example", token: "test-token" },
      {
        method: "POST",
        path: "/cookies/set-many",
        query: { profile: "work" },
        body: {
          cookies: [expect.objectContaining({ name: "session", domain: ".example.com" })],
        },
      },
      { scopes: ["operator.admin"] },
    ]);
    const summary = runtime.log.mock.calls.at(-1)?.[0];
    expect(summary).toContain("chrome/Default -> work via wss://gateway.example");
    expect(summary).not.toContain("cookie-secret");
  });
});
