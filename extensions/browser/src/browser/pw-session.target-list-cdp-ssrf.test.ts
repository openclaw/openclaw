import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
// Browser tests cover the target-list /json/list lookup CDP discovery policy.
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

function installTargetListFallbackBrowser(): void {
  const page = {
    on: vi.fn(),
    context: () => context,
    url: vi.fn(() => "https://alpha.example"),
  } as unknown as import("playwright-core").Page;
  const context = {
    pages: () => [page],
    on: vi.fn(),
    // Force the target-list /json/list fallback: per-page CDP probing fails so
    // findPageByTargetId cannot resolve the id via Playwright.
    newCDPSession: vi.fn(async () => {
      throw new Error("Target.attachToBrowserTarget: Not allowed");
    }),
  } as unknown as import("playwright-core").BrowserContext;
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
}

function resolveGuardPolicy(): SsrFPolicy | undefined {
  const [call] = fetchWithSsrFGuardMock.mock.calls;
  if (!call) {
    throw new Error("expected a guarded /json/list fetch");
  }
  const [request] = call as [{ url: string; policy?: SsrFPolicy }];
  return request.policy;
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  fetchWithSsrFGuardMock.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session target-list CDP discovery policy", () => {
  it("passes the caller's discovery policy to the /json/list fetch guard", async () => {
    installTargetListFallbackBrowser();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () =>
          new TextEncoder().encode(
            JSON.stringify([{ id: "TARGET_B", url: "https://beta.example" }]),
          ).buffer,
      },
      release: vi.fn(async () => {}),
    });

    // A distinctive caller flag that the scoped discovery policy must carry
    // through to the fetch layer. Before the fix the fetch received no policy
    // argument, so this caller flag was dropped.
    await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: false,
        allowRfc2544BenchmarkRange: true,
      },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const policy = resolveGuardPolicy();
    expect(policy?.allowRfc2544BenchmarkRange).toBe(true);
    expect(policy?.hostnameAllowlist).toEqual(["127.0.0.1"]);
  });
});
