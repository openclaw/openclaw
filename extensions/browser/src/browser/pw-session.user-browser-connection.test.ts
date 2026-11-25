import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdBrowserConnection } from "./browser-connection-holds.js";
import {
  registerBorrowedRelayCdpAccess,
  registerOwnedRelayCdpPort,
  type BorrowedRelayAccess,
} from "./extension-relay/relay-access.js";
import { USER_BROWSER_IDLE_RELEASE_MS } from "./pw-session-contracts.js";
import { makeTargetBrowser } from "./pw-session.browser.test-support.js";
import { setupPwSessionConnectionTest } from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketEndpointSpy, markTargetBlocked, pwAi } =
  setupPwSessionConnectionTest();
const { getPageForTargetId, hasCachedPlaywrightBrowserConnection } = pwAi;
// Import after the support module mocks the CDP transport.
const { isBlockedTarget } = await import("./pw-session-connection.js");

const ownedRelayPort = 19333;
const ownedCdpUrl = `http://openclaw-internal:relay-test-key@127.0.0.1:${ownedRelayPort}`;
const borrowedCdpUrl = "http://127.0.0.1:19334";
const managedCdpUrl = "http://127.0.0.1:19335";
const relays = [
  ["owned", ownedCdpUrl],
  ["borrowed", borrowedCdpUrl],
] as const;
const registrations: Array<() => void> = [];

function borrowedRelay(): BorrowedRelayAccess {
  return {
    ownership: "borrowed",
    port: 19334,
    token: "relay-test-key",
    allowLegacyAuth: false,
    client: {
      assertCurrent: () => {},
      openTransport: async () => ({ send: () => {}, close: () => {} }),
    } as unknown as BorrowedRelayAccess["client"],
    close: async () => {},
  };
}

function queueBrowsers(count: number) {
  const fixtures = Array.from({ length: count }, () =>
    makeTargetBrowser("TAB", "https://example.com/"),
  );
  for (const fixture of fixtures) {
    connectOverCdpSpy.mockResolvedValueOnce(fixture.browser);
  }
  return fixtures;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  getChromeWebSocketEndpointSpy.mockImplementation(async (cdpUrl: string) => ({
    url: `ws://${new URL(cdpUrl).host}/devtools/browser/test`,
  }));
  registrations.push(registerOwnedRelayCdpPort(ownedRelayPort));
  registrations.push(registerBorrowedRelayCdpAccess(borrowedCdpUrl, borrowedRelay()));
});

afterEach(() => {
  for (const unregister of registrations.splice(0)) {
    unregister();
  }
});

describe("connections to the user's own browser", () => {
  it.each(relays)(
    "connects through an %s relay without Playwright's default overrides",
    async (_, cdpUrl) => {
      queueBrowsers(1);
      await getPageForTargetId({ cdpUrl, targetId: "TAB" });
      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
      expect(connectOverCdpSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ noDefaults: true }),
      );
    },
  );

  it("keeps Playwright defaults and the cached connection for a browser OpenClaw launched", async () => {
    const [managed] = queueBrowsers(1);
    await getPageForTargetId({ cdpUrl: managedCdpUrl, targetId: "TAB" });
    expect(connectOverCdpSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ noDefaults: expect.anything() }),
    );
    await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS * 2);
    expect(managed?.browserClose).not.toHaveBeenCalled();
    expect(hasCachedPlaywrightBrowserConnection(managedCdpUrl)).toBe(true);
  });

  it.each(relays)(
    "releases an idle %s relay connection and reconnects on next use",
    async (_, cdpUrl) => {
      const [first, second] = queueBrowsers(2);
      await getPageForTargetId({ cdpUrl, targetId: "TAB" });

      await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS - 1);
      expect(first?.browserClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(first?.browserClose).toHaveBeenCalledOnce();
      expect(hasCachedPlaywrightBrowserConnection(cdpUrl)).toBe(false);

      await expect(getPageForTargetId({ cdpUrl, targetId: "TAB" })).resolves.toBe(second?.page);
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("never releases a connection another runtime or recording still holds", async () => {
    const [connection] = queueBrowsers(1);
    const releaseStoppedRuntime = holdBrowserConnection(ownedCdpUrl);
    await getPageForTargetId({ cdpUrl: ownedCdpUrl, targetId: "TAB" });
    const releaseSuccessor = holdBrowserConnection(ownedCdpUrl);

    releaseStoppedRuntime();
    await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS * 3);
    expect(connection?.browserClose).not.toHaveBeenCalled();

    releaseSuccessor();
    await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS - 1);
    expect(connection?.browserClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection?.browserClose).toHaveBeenCalledOnce();
  });

  it("cancels the idle release of a connection a lifecycle transition retires", async () => {
    const [retired, successor] = queueBrowsers(2);
    await getPageForTargetId({ cdpUrl: ownedCdpUrl, targetId: "TAB" });
    await pwAi.retirePlaywrightBrowserConnectionExact({ cdpUrl: ownedCdpUrl }).close();
    expect(retired?.browserClose).toHaveBeenCalledOnce();

    const releaseSuccessor = holdBrowserConnection(ownedCdpUrl);
    await getPageForTargetId({ cdpUrl: ownedCdpUrl, targetId: "TAB" });
    await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS * 2);
    expect(retired?.browserClose).toHaveBeenCalledOnce();
    expect(successor?.browserClose).not.toHaveBeenCalled();

    releaseSuccessor();
    await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS);
    expect(successor?.browserClose).toHaveBeenCalledOnce();
  });

  it("keeps quarantined targets blocked across an idle release", async () => {
    queueBrowsers(1);
    await getPageForTargetId({ cdpUrl: ownedCdpUrl, targetId: "TAB" });
    markTargetBlocked(ownedCdpUrl, "BLOCKED");
    await vi.advanceTimersByTimeAsync(USER_BROWSER_IDLE_RELEASE_MS);
    expect(hasCachedPlaywrightBrowserConnection(ownedCdpUrl)).toBe(false);
    expect(isBlockedTarget(ownedCdpUrl, "BLOCKED")).toBe(true);
  });
});
