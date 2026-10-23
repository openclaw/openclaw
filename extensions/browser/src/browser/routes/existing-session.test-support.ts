import { setTimeout as sleep } from "node:timers/promises";
import { expect, vi, type Mock } from "vitest";
import type { ChromeMcpOperationOptions } from "../chrome-mcp.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { BrowserRouteContext } from "../server-context.js";
import { startRoute } from "./agent-route.test-support.js";
import type { BrowserDispatchRequest, BrowserDispatchResponse } from "./dispatcher.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";

const makeTab = () => ({ targetId: "7", url: "https://example.com" });

export const existingSessionRouteState = {
  profileCtx: {
    profile: { driver: "existing-session" as const, name: "chrome-live" },
    listTabs: vi.fn(async () => [makeTab()]),
    ensureTabAvailable: vi.fn(async () => makeTab()),
    closeTab: vi.fn(async () => {}),
  },
  tab: makeTab(),
};

export function createExistingSessionAgentSharedModule() {
  return {
    browserNavigationPolicyForProfile: vi.fn((ctx: BrowserRouteContext) =>
      withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy),
    ),
    handleRouteError: vi.fn((res: BrowserResponse, err: unknown) => {
      res.status(400);
      res.json({ error: err instanceof Error ? err.message : String(err) });
    }),
    readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
    requirePwAi: vi.fn(async () => {
      throw new Error("Playwright should not be used for existing-session tests");
    }),
    resolveProfileContext: vi.fn(() => existingSessionRouteState.profileCtx),
    resolveSafeRouteTabUrl: vi.fn(
      async (params: {
        profileCtx: typeof existingSessionRouteState.profileCtx;
        targetId: string;
        fallbackUrl?: string;
      }) => {
        const tabs = await params.profileCtx.listTabs();
        return tabs.find((tab) => tab.targetId === params.targetId)?.url ?? params.fallbackUrl;
      },
    ),
    withPlaywrightRouteContext: vi.fn(),
    withRouteTabContext: vi.fn(
      async (options: {
        ctx: BrowserRouteContext;
        enforceCurrentUrlAllowed?: boolean;
        req: BrowserRequest;
        run: (args: unknown) => Promise<void>;
      }) => {
        const { ctx, enforceCurrentUrlAllowed, req, run } = options;
        if (enforceCurrentUrlAllowed) {
          const ssrfPolicyOpts = withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy);
          if (ssrfPolicyOpts.ssrfPolicy) {
            await assertBrowserNavigationResultAllowed({
              url: existingSessionRouteState.tab.url,
              ...ssrfPolicyOpts,
            });
          }
        }
        await run({
          profileCtx: existingSessionRouteState.profileCtx,
          cdpUrl: "http://127.0.0.1:18800",
          tab: existingSessionRouteState.tab,
          signal: req.signal ?? new AbortController().signal,
          resolveTabUrl: vi.fn(
            async (fallbackUrl?: string) => fallbackUrl ?? existingSessionRouteState.tab.url,
          ),
        });
      },
    ),
  };
}

export function createExistingSessionClientHarness(
  dispatch: Mock<(request: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>>,
  actRoute: (
    policy: { readonly allowPrivateNetwork: false } | null,
  ) => Parameters<typeof startRoute>[0],
  browserAct: typeof import("../client-actions.js").browserAct,
) {
  type Policy = { readonly allowPrivateNetwork: false } | null;
  const clientControllers: AbortController[] = [];
  async function startClientAction(body: BrowserActRequest, ssrfPolicy: Policy = null) {
    const handler = actRoute(ssrfPolicy);
    dispatch.mockImplementation(async (request) => {
      const { response, completion } = startRoute(handler, {
        ...request,
        query: request.query ?? {},
      });
      try {
        await completion;
      } catch (error) {
        response.res.status(500).json({ error: String(error) });
      }
      return { status: response.statusCode, body: response.body };
    });
    const controller = new AbortController();
    clientControllers.push(controller);
    const settled = vi.fn();
    const completion = browserAct(undefined, body, {
      profile: "chrome-live",
      signal: controller.signal,
    }).then(
      (result) => {
        settled();
        return { result };
      },
      (error: unknown) => {
        settled();
        return { error };
      },
    );
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    return { completion, settled };
  }

  async function expectClientError(
    request: Awaited<ReturnType<typeof startClientAction>>,
    message: string,
  ) {
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining(message) }),
    });
  }

  async function expectPendingThenSuccess(
    request: Awaited<ReturnType<typeof startClientAction>>,
    pendingMs: number,
    remainingMs: number,
    result: object,
  ) {
    await vi.advanceTimersByTimeAsync(pendingMs);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(remainingMs);
    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({ result });
  }

  async function expectDeadline(
    request: Awaited<ReturnType<typeof startClientAction>>,
    signal: AbortSignal | undefined,
    message: string,
  ) {
    expect(signal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, message);
    expect(dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  }

  return {
    clientControllers,
    startClientAction,
    expectClientError,
    expectPendingThenSuccess,
    expectDeadline,
  };
}

export function delayed<T>(ms: number, value: T, completed = () => {}) {
  return async ({ signal }: ChromeMcpOperationOptions) => {
    await sleep(ms, undefined, { signal });
    completed();
    return value;
  };
}

export async function launchChromiumRoutePage(profileDir: string, args: string[] = []) {
  const { getFreePort } = await import("../test-port.js");
  const { getPlaywrightCore } = await import("../playwright-core.runtime.js");
  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const context = await getPlaywrightCore().chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [`--remote-debugging-port=${port}`, ...args],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    return { context, page, cdpUrl, targetId: targetInfo.targetId };
  } catch (error) {
    await context.close();
    throw error;
  }
}
