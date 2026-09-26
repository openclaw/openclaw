import type { WatchOptions } from "@openclaw/fs-safe/watch";
import { Command } from "commander";
import * as cliRuntime from "openclaw/plugin-sdk/cli-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true, targetId: "tab-1", added: 1 })),
}));

const watchMocks = vi.hoisted(() => ({ watch: vi.fn(), readSecret: vi.fn() }));
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMocks.watch }));
vi.mock("@openclaw/fs-safe/root", () => ({
  root: vi.fn(async () => ({ [Symbol.asyncDispose]: vi.fn(async () => {}) })),
}));
vi.mock("../browser/system-chrome-cookies.js", () => ({
  cacheKeychainSecret: vi.fn(async () => watchMocks.readSecret),
}));

const systemProfileMocks = vi.hoisted(() => ({
  readSystemProfileCookies: vi.fn(async () => ({
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
  })),
}));

vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(gatewayMocks.callGatewayFromCli);

vi.mock("../system-profile-api.js", () => ({
  assertSystemCookiePlatform: vi.fn(),
  readSystemProfileCookies: systemProfileMocks.readSystemProfileCookies,
  resolveSystemCookieSource: vi.fn(() => ({
    browser: "chrome",
    cookiesFile: "/synthetic/Cookies",
  })),
}));

vi.spyOn(cliRuntime, "runCommandWithRuntime").mockImplementation(
  async (_runtime, action, onError) => {
    try {
      await action();
    } catch (error) {
      onError?.(error);
    }
  },
);
vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);

let registerBrowserCookieSyncCommand: typeof import("./browser-cli-cookie-sync.js").registerBrowserCookieSyncCommand;

function createProgram() {
  const program = new Command();
  const browser = program
    .command("browser")
    .option("--url <url>", "Gateway URL")
    .option("--token <token>", "Gateway token")
    .option("--timeout <ms>", "Timeout", "30000");
  registerBrowserCookieSyncCommand(browser, (command) => command.optsWithGlobals());
  return program;
}

describe("browser cookie-sync CLI", () => {
  beforeAll(async () => {
    ({ registerBrowserCookieSyncCommand } = await import("./browser-cli-cookie-sync.js"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    gatewayMocks.callGatewayFromCli.mockClear();
    systemProfileMocks.readSystemProfileCookies.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resyncs changes received during a pending push and settles on stop", async () => {
    vi.useFakeTimers();
    const firstPush = createDeferred<{ ok: boolean; targetId: string; added: number }>();
    const secondPush = createDeferred<{ ok: boolean; targetId: string; added: number }>();
    gatewayMocks.callGatewayFromCli.mockImplementationOnce(async () => firstPush.promise);
    gatewayMocks.callGatewayFromCli.mockImplementationOnce(async () => secondPush.promise);
    const watcher = { ready: Promise.resolve(), close: vi.fn(async () => {}) };
    let changed: WatchOptions["onInvalidate"] = () => {};
    watchMocks.watch.mockImplementation((_root, options: WatchOptions) => {
      changed = options.onInvalidate;
      return watcher;
    });
    const running = createProgram().parseAsync(
      ["browser", "cookie-sync", "--domains", "example.com", "--watch"],
      { from: "user" },
    );
    try {
      await vi.waitFor(() => expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledTimes(1));
      changed({ reason: "event", changes: [{ path: "Cookies-wal", type: "content" }] });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledTimes(1);
      firstPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      await vi.waitFor(() => expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledTimes(2));
      changed({ reason: "event", changes: [{ path: "Cookies", type: "structural" }] });
      await vi.advanceTimersByTimeAsync(1_500);
      process.emit("SIGINT");
      secondPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      await running;
      expect(systemProfileMocks.readSystemProfileCookies).toHaveBeenCalledTimes(2);
      expect(watcher.close).toHaveBeenCalledOnce();
    } finally {
      process.emit("SIGINT");
      firstPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      secondPush.resolve({ ok: true, targetId: "tab-1", added: 1 });
      await running;
    }
  });

  it("requires a non-empty domain allowlist before any read or gateway call", async () => {
    await expect(
      createProgram().parseAsync(["browser", "cookie-sync"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("--domains is required");
    expect(systemProfileMocks.readSystemProfileCookies).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("reads allowlisted cookies locally and posts them through browser.request", async () => {
    await createProgram().parseAsync(
      [
        "browser",
        "--url",
        "wss://gateway.example",
        "--token",
        "test-token",
        "cookie-sync",
        "--domains",
        "example.com, accounts.example.com",
        "--into",
        "work",
        "--browser",
        "chrome",
        "--system",
        "Profile 1",
      ],
      { from: "user" },
    );

    expect(systemProfileMocks.readSystemProfileCookies).toHaveBeenCalledWith(
      {
        browser: "chrome",
        systemProfile: "Profile 1",
        domains: ["example.com", "accounts.example.com"],
        signal: undefined,
      },
      { readSecret: undefined },
    );
    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ url: "wss://gateway.example", token: "test-token" }),
      {
        method: "POST",
        path: "/cookies/set-many",
        query: { profile: "work" },
        body: {
          cookies: [expect.objectContaining({ name: "session", domain: ".example.com" })],
        },
        timeoutMs: 30_000,
      },
      { progress: undefined, scopes: ["operator.admin"] },
    );
    expect(runtime.log.mock.calls.at(-1)?.[0]).toContain(
      "chrome/Default -> work via wss://gateway.example",
    );
    expect(runtime.log.mock.calls.at(-1)?.[0]).not.toContain("cookie-secret");
  });
});
