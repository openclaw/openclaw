import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-support/browser-security.mock.js";
import * as navigationGuard from "../navigation-guard.js";
import {
  clearBrowserScreencastTokens,
  consumeBrowserScreencastToken,
} from "../screencast/tokens.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  getOrCreateProfileRuntime,
  getProfileLifecycle,
  markBrowserRuntimeStopping,
} from "../server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { expectResponseContaining, runRoute } from "./agent-route.test-support.js";
import { registerBrowserAgentScreencastRoutes } from "./agent.screencast.js";
import { handleRouteError, resolveSafeRouteTabUrl } from "./agent.shared.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const pw = vi.hoisted(() => ({ available: true }));

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => (pw.available ? {} : null),
  getLoadedPwAiModule: () => null,
}));

function requesterFixture() {
  const connection = new AbortController();
  const requester = {
    invalidated: false,
    signal: connection.signal,
    isCurrent: () => !requester.invalidated && !connection.signal.aborted,
  };
  return { connection, requester };
}

function setup(
  options: {
    existingSession?: boolean;
    url?: string;
    listedUrl?: string;
    emptyListing?: boolean;
  } = {},
) {
  const profile = makeBrowserProfile(options.existingSession ? { driver: "existing-session" } : {});
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: { ssrfPolicy: { allowPrivateNetwork: false } },
  });
  const runtime = getOrCreateProfileRuntime(state, profile);
  const tab = {
    targetId: "resolved-tab",
    url: options.url ?? "https://example.com/",
  };
  const ensureTabAvailable = vi.fn(async () => tab);
  const ctx = {
    state: () => state,
    forProfile: () => ({
      profile,
      ensureTabAvailable,
      listTabs: async () =>
        options.emptyListing ? [] : [{ ...tab, url: options.listedUrl ?? tab.url }],
    }),
  } as unknown as BrowserRouteContext;
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentScreencastRoutes(app, ctx);
  const route = postHandlers.get("/screencast")!;
  return {
    state,
    runtime,
    ensureTabAvailable,
    ctx,
    request: (body: Record<string, unknown> = {}, requester?: BrowserRequest["requester"]) =>
      runRoute(route, { body, requester }),
  };
}

describe("browser screencast mint route", () => {
  beforeEach(() => {
    pw.available = true;
  });

  afterEach(() => {
    clearBrowserScreencastTokens();
    vi.restoreAllMocks();
  });

  it.each([
    { when: "before request", abort: true },
    { when: "during tab resolution", abort: false },
  ])("rejects a requester invalidated $when (socket closed: $abort)", async ({ when, abort }) => {
    const { connection, requester } = requesterFixture();
    const { request, ensureTabAvailable } = setup();
    if (when === "before request") {
      connection.abort();
    } else {
      const resolveTab = ensureTabAvailable.getMockImplementation()!;
      ensureTabAvailable.mockImplementationOnce(async () => {
        requester.invalidated = true;
        return await resolveTab();
      });
    }
    const response = await request({}, requester);
    expect(connection.signal.aborted).toBe(abort);
    expectResponseContaining(response, { code: "SCREENCAST_REQUESTER_GONE" }, 401);
    expect(response.body).not.toHaveProperty("token");
  });

  it.each(["socket close", "invalidation"])("binds a minted token to requester %s", async (end) => {
    const { connection, requester } = requesterFixture();
    const { request } = setup();
    const response = await request({}, requester);
    const token = (response.body as { token: string }).token;
    expect(response.statusCode).toBe(200);
    if (end === "socket close") {
      connection.abort();
    } else {
      requester.invalidated = true;
    }
    expect(connection.signal.aborted).toBe(end === "socket close");
    expect(consumeBrowserScreencastToken(token)).toBeUndefined();
  });

  it.each([
    { existingSession: true, playwright: true, reason: "existing-session" },
    { existingSession: false, playwright: false, reason: "playwright" },
  ])("reports $reason as unsupported", async ({ existingSession, playwright, reason }) => {
    pw.available = playwright;
    const response = await setup({ existingSession }).request();
    expectResponseContaining(
      response,
      {
        error: expect.any(String),
        code: "SCREENCAST_UNSUPPORTED",
        reason,
      },
      501,
    );
  });

  it("mints an expiring token scoped to the resolved target with bounded capture options", async () => {
    const { request, ensureTabAvailable } = setup({ emptyListing: true });
    const startedAt = Date.now();
    const response = await request({ targetId: "t1", maxWidth: 17, maxHeight: 9000, quality: 99 });
    const body = response.body as { token: string; wsPath: string; expiresAtMs: number };

    expectResponseContaining(response, {
      token: expect.stringMatching(/^[a-f0-9]{48}$/),
      wsPath: `/browser/screencast?token=${body.token}`,
      targetId: "resolved-tab",
      url: "https://example.com/",
    });
    expect(body.expiresAtMs).toBeGreaterThanOrEqual(startedAt + 60_000);
    expect(ensureTabAvailable).toHaveBeenCalledWith("t1", expect.any(Object));
    expect(consumeBrowserScreencastToken(body.token)).toMatchObject({
      profileName: "openclaw",
      targetId: "resolved-tab",
      cdpUrl: "http://127.0.0.1:18800",
      maxWidth: 320,
      maxHeight: 2000,
      quality: 90,
    });
  });

  it("keeps default bounds and checks current navigation policy after config changes", async () => {
    const { request, state, runtime } = setup();
    state.resolved.ssrfPolicy = { allowPrivateNetwork: true };
    const response = await request();
    const token = consumeBrowserScreencastToken((response.body as { token: string }).token)!;

    expect(token).toMatchObject({ maxWidth: 1280, maxHeight: 1280, quality: 70 });
    await expect(token.checkNavigationAllowed("http://127.0.0.1/")).resolves.toBeUndefined();
    state.resolved.ssrfPolicy = { allowPrivateNetwork: false };
    await expect(token.checkNavigationAllowed("http://127.0.0.1/")).rejects.toThrow();
    getProfileLifecycle(runtime).controller.abort();
    expect(() => token.assertCurrent()).toThrow("superseded");
  });

  it("blocks minting for a disallowed current tab through the shared route guard", async () => {
    const response = await setup({ url: "http://127.0.0.1/private" }).request();
    expectResponseContaining(response, { reason: "navigation_blocked" }, 400);
    expect(response.body).not.toHaveProperty("token");
  });

  it.each(["runtime retirement", "profile removal"] as const)(
    "rejects a minted token after %s",
    async (transition) => {
      const { request, state } = setup();
      const response = await request();
      const token = consumeBrowserScreencastToken((response.body as { token: string }).token)!;

      if (transition === "runtime retirement") {
        markBrowserRuntimeStopping(state);
      } else {
        state.profiles.delete("openclaw");
      }

      expect(() => token.assertCurrent()).toThrow("superseded");
    },
  );

  it("redacts a newly blocked listed URL in the mint response", async () => {
    const response = await setup({ listedUrl: "http://127.0.0.1/private" }).request();
    expectResponseContaining(response, { token: expect.any(String), url: undefined });
  });

  it("redacts credentials from unmapped route errors", () => {
    const response = createBrowserRouteResponse();
    handleRouteError(
      response.res,
      new Error(
        "connect failed for wss://browser-user:browser-password@browserless.example/cdp?token=browser-token",
      ),
    );
    expectResponseContaining(
      response,
      { error: expect.stringContaining("browserless.example") },
      500,
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /browser-user|browser-password|browser-token/,
    );
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
    const { ctx } = setup();
    await expect(
      resolveSafeRouteTabUrl({
        ctx,
        profileCtx: ctx.forProfile(),
        targetId: "resolved-tab",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
