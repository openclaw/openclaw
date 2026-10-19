import { describe, expect, it, vi } from "vitest";
import * as navigationGuard from "../navigation-guard.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import "../../test-support/browser-security.mock.js";
import { handleRouteError, resolveSafeRouteTabUrl, withRouteTabContext } from "./agent.shared.js";
import { createBrowserRouteResponse } from "./test-helpers.js";

function routeContext(ssrfPolicy?: unknown) {
  return {
    state: () => ({
      resolved: {
        extraArgs: [],
        ssrfPolicy,
      },
    }),
  };
}

function profileContext(tabs: Array<{ targetId: string; url: string }>) {
  return {
    profile: {
      cdpIsLoopback: true,
      driver: "openclaw",
    },
    listTabs: async () => tabs,
  };
}

function routeContextForTab(
  url: string,
  ensureTabAvailable = vi.fn(async () => ({
    targetId: "tab-1",
    title: "Tab",
    url,
    type: "page",
  })),
): BrowserRouteContext {
  const profileCtx = {
    profile: {
      cdpUrl: "http://127.0.0.1:9222",
      name: "default",
    },
    ensureTabAvailable,
  } as unknown as ProfileContext;

  return {
    forProfile: () => profileCtx,
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        ssrfPolicy: {},
      },
    }),
  } as unknown as BrowserRouteContext;
}

describe("browser route shared helpers", () => {
  it("does not interact after dashboard ownership changes during target resolution", async () => {
    let ownerCurrent = true;
    const ctx = routeContextForTab(
      "https://example.com",
      vi.fn(async () => {
        ownerCurrent = false;
        return { targetId: "tab-1", title: "Tab", url: "https://example.com", type: "page" };
      }),
    );
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
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("dashboard was removed"),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("redacts credentials from unmapped route errors", () => {
    const response = createBrowserRouteResponse();
    const error = new Error(
      "connect failed for wss://browser-user:browser-password@browserless.example/cdp?token=browser-token",
    );

    handleRouteError(response.res, error);

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ error: expect.stringContaining("browserless.example") });
    expect(JSON.stringify(response.body)).not.toContain("browser-user");
    expect(JSON.stringify(response.body)).not.toContain("browser-password");
    expect(JSON.stringify(response.body)).not.toContain("browser-token");
  });

  describe("safe route tab URLs", () => {
    it("falls back to the ensured tab URL when tab listing is stale", async () => {
      await expect(
        resolveSafeRouteTabUrl({
          ctx: routeContext() as never,
          profileCtx: profileContext([]) as never,
          targetId: "tab-1",
          fallbackUrl: "https://example.com/fallback",
        }),
      ).resolves.toBe("https://example.com/fallback");
    });

    it("omits URLs blocked by the browser SSRF policy", async () => {
      await expect(
        resolveSafeRouteTabUrl({
          ctx: routeContext({ dangerouslyAllowPrivateNetwork: false }) as never,
          profileCtx: profileContext([
            { targetId: "tab-1", url: "http://127.0.0.1:9222/" },
          ]) as never,
          targetId: "tab-1",
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
      try {
        await expect(
          resolveSafeRouteTabUrl({
            ctx: routeContext() as never,
            profileCtx: profileContext([
              { targetId: "tab-1", url: "https://example.com/current" },
            ]) as never,
            targetId: "tab-1",
            signal: controller.signal,
          }),
        ).rejects.toBe(reason);
        expect(guard).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
      } finally {
        guard.mockRestore();
      }
    });
  });
});
