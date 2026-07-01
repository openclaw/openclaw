// Cookie persistence tests cover the managed-Chrome CDP sidecar.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const withCdpSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./cdp.helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cdp.helpers.js")>();
  return {
    ...actual,
    withCdpSocket: (...args: unknown[]) => withCdpSocketMock(...args),
  };
});

import {
  COOKIE_FLUSH_INTERVAL_MS,
  resolveCookieStorePath,
  restoreManagedChromeCookies,
  saveManagedChromeCookies,
  startManagedChromeCookieFlush,
} from "./cookie-persistence.js";

describe("managed Chrome cookie persistence", () => {
  let root = "";
  let userDataDir = "";

  beforeEach(async () => {
    vi.useRealTimers();
    withCdpSocketMock.mockReset();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-cookie-persistence-"));
    userDataDir = path.join(root, "browser", "openclaw", "user-data");
    await fsp.mkdir(userDataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("stores non-empty CDP cookie snapshots beside the managed profile with 0600 permissions", async () => {
    const cookies = [{ name: "session", value: "abc", domain: "example.com", path: "/" }];
    withCdpSocketMock.mockImplementationOnce(async (_wsUrl, callback) => {
      return await callback(async (method: string) => {
        expect(method).toBe("Storage.getCookies");
        return { cookies };
      });
    });

    await saveManagedChromeCookies("ws://127.0.0.1/devtools/browser/mock", userDataDir);

    const file = resolveCookieStorePath(userDataDir);
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as {
      savedAt?: number;
      cookies?: unknown[];
    };
    expect(parsed.cookies).toEqual(cookies);
    expect(typeof parsed.savedAt).toBe("number");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
  });

  it("clears an existing snapshot with an empty CDP cookie result", async () => {
    const file = resolveCookieStorePath(userDataDir);
    await fsp.writeFile(file, JSON.stringify({ savedAt: 1, cookies: [{ name: "kept" }] }), {
      mode: 0o600,
    });
    withCdpSocketMock.mockImplementationOnce(async (_wsUrl, callback) => {
      return await callback(async () => ({ cookies: [] }));
    });

    await saveManagedChromeCookies("ws://127.0.0.1/devtools/browser/mock", userDataDir);

    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps an existing snapshot when the CDP result is malformed", async () => {
    const file = resolveCookieStorePath(userDataDir);
    await fsp.writeFile(file, JSON.stringify({ savedAt: 1, cookies: [{ name: "kept" }] }), {
      mode: 0o600,
    });
    withCdpSocketMock.mockImplementationOnce(async (_wsUrl, callback) => {
      return await callback(async () => ({}));
    });

    await saveManagedChromeCookies("ws://127.0.0.1/devtools/browser/mock", userDataDir);

    expect(JSON.parse(await fsp.readFile(file, "utf8"))).toEqual({
      savedAt: 1,
      cookies: [{ name: "kept" }],
    });
  });

  it("restores saved cookies through browser-level Storage.setCookies", async () => {
    const cookies = [{ name: "session", value: "abc", domain: "example.com", path: "/" }];
    await fsp.writeFile(resolveCookieStorePath(userDataDir), JSON.stringify({ cookies }), {
      mode: 0o600,
    });
    const send = vi.fn(async () => ({}));
    withCdpSocketMock.mockImplementationOnce(async (_wsUrl, callback) => {
      return await callback(send);
    });

    await restoreManagedChromeCookies("ws://127.0.0.1/devtools/browser/mock", userDataDir);

    expect(send).toHaveBeenCalledWith("Storage.setCookies", { cookies });
  });

  it("normalizes session cookie snapshots before restore", async () => {
    await fsp.writeFile(
      resolveCookieStorePath(userDataDir),
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "abc",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            size: 10,
            session: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const send = vi.fn(async () => ({}));
    withCdpSocketMock.mockImplementationOnce(async (_wsUrl, callback) => {
      return await callback(send);
    });

    await restoreManagedChromeCookies("ws://127.0.0.1/devtools/browser/mock", userDataDir);

    expect(send).toHaveBeenCalledWith("Storage.setCookies", {
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: "example.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
    });
  });

  it("starts an unrefed periodic cookie flush timer", () => {
    vi.useFakeTimers();
    withCdpSocketMock.mockResolvedValue({ cookies: [{ name: "session" }] });

    const timer = startManagedChromeCookieFlush(
      "ws://127.0.0.1/devtools/browser/mock",
      userDataDir,
    );

    expect(typeof timer.unref).toBe("function");
    vi.advanceTimersByTime(COOKIE_FLUSH_INTERVAL_MS);
    expect(withCdpSocketMock).toHaveBeenCalledOnce();
    clearInterval(timer);
  });
});
