import type { Browser, BrowserContext } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

const stateMocks = vi.hoisted(() => ({
  ensurePageState: vi.fn(),
  getPageForTargetId: vi.fn(),
}));

// mock-isolation: the page lookup returns a fixture page; no real browser connection is opened.
vi.mock("./pw-session.js", () => ({
  ensurePageState: stateMocks.ensurePageState,
  getPageForTargetId: stateMocks.getPageForTargetId,
}));

import { interception, markRelayBrowser } from "./pw-session-http-auth.js";
import { setHttpCredentialsViaPlaywright } from "./pw-tools-core.state.js";

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };

function pageOn(browser: object) {
  const setHTTPCredentials = vi.fn(async () => {});
  const context = { browser: () => browser, setHTTPCredentials };
  stateMocks.getPageForTargetId.mockResolvedValue({ context: () => context });
  return { context: context as unknown as BrowserContext, setHTTPCredentials };
}

describe("setHttpCredentialsViaPlaywright", () => {
  it("keeps extension-relay credentials off a second Fetch interception session", async () => {
    const browser = {};
    markRelayBrowser(browser as Browser);
    const { context, setHTTPCredentials } = pageOn(browser);

    await setHttpCredentialsViaPlaywright({ ...target, username: "user", password: "secret" });
    expect(setHTTPCredentials).not.toHaveBeenCalled();
    expect(interception(context)).toEqual({ handleAuthRequests: true });

    await setHttpCredentialsViaPlaywright({ ...target, clear: true });
    expect(setHTTPCredentials).not.toHaveBeenCalled();
    expect(interception(context)).toEqual({});
  });

  it("answers from both Playwright and the tab fence for directly connected browsers", async () => {
    const { context, setHTTPCredentials } = pageOn({});

    await setHttpCredentialsViaPlaywright({ ...target, username: "user", password: "secret" });
    expect(setHTTPCredentials).toHaveBeenCalledWith({ username: "user", password: "secret" });
    // The tab fence intercepts documents on every transport, so it answers too.
    expect(interception(context)).toEqual({ handleAuthRequests: true });

    await setHttpCredentialsViaPlaywright({ ...target, clear: true });
    expect(setHTTPCredentials).toHaveBeenLastCalledWith(null);
    expect(interception(context)).toEqual({});
  });
});
