import { afterEach, describe, expect, it, vi } from "vitest";
import * as navigationGuard from "../navigation-guard.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import "../../test-support/browser-security.mock.js";
import { handleRouteError, resolveSafeRouteTabUrl, withRouteTabContext } from "./agent.shared.js";
import { createBrowserRouteResponse } from "./test-helpers.js";

function safeUrl(
  url?: string,
  options: {
    fallbackUrl?: string;
    signal?: AbortSignal;
    ssrfPolicy?: unknown;
  } = {},
) {
  return resolveSafeRouteTabUrl({
    ctx: {
      state: () => ({ resolved: { extraArgs: [], ssrfPolicy: options.ssrfPolicy } }),
    } as never,
    profileCtx: {
      profile: { cdpIsLoopback: true, driver: "openclaw" },
      listTabs: async () => (url ? [{ targetId: "tab-1", url }] : []),
    } as never,
    targetId: "tab-1",
    fallbackUrl: options.fallbackUrl,
    signal: options.signal,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("browser route shared helpers", () => {
  it("does not interact after dashboard ownership changes during target resolution", async () => {
    let ownerCurrent = true;
    const profileCtx = {
      profile: { cdpUrl: "http://127.0.0.1:9222", name: "default" },
      ensureTabAvailable: async () => {
        ownerCurrent = false;
        return { targetId: "tab-1", title: "Tab", url: "https://example.com", type: "page" };
      },
    } as unknown as ProfileContext;
    const ctx = {
      forProfile: () => profileCtx,
      state: () => ({ resolved: { actionTimeoutMs: 60_000, ssrfPolicy: {} } }),
    } as unknown as BrowserRouteContext;
    const response = createBrowserRouteResponse();
    const run = vi.fn(async () => "mutated");
    await withRouteTabContext({
      req: {
        params: {},
        query: {},
        assertCurrent: async () => {
          if (!ownerCurrent) {
            throw new Error("dashboard was removed");
          }
        },
      },
      res: response.res,
      ctx,
      targetId: "tab-1",
      run,
    });
    expect(response).toMatchObject({
      statusCode: 500,
      body: { error: expect.stringContaining("dashboard was removed") },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("redacts credentials from unmapped route errors", () => {
    const response = createBrowserRouteResponse();
    const error = new Error(
      "connect failed for wss://browser-user:browser-password@browserless.example/cdp?token=browser-token",
    );

    handleRouteError(response.res, error);

    expect(response).toMatchObject({
      statusCode: 500,
      body: { error: expect.stringContaining("browserless.example") },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /browser-user|browser-password|browser-token/,
    );
  });

  it("falls back to the ensured tab URL when tab listing is stale", async () => {
    await expect(safeUrl(undefined, { fallbackUrl: "https://example.com/fallback" })).resolves.toBe(
      "https://example.com/fallback",
    );
  });

  it("omits URLs blocked by the browser SSRF policy", async () => {
    await expect(
      safeUrl("http://127.0.0.1:9222/", {
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates cancelled URL verification instead of returning a redacted URL", async () => {
    const controller = new AbortController();
    const reason = new Error("browser navigation verification deadline expired");
    const guard = vi
      .spyOn(navigationGuard, "assertBrowserNavigationResultAllowed")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });
    await expect(
      safeUrl("https://example.com/current", { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
