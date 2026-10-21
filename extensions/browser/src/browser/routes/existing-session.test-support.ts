import { vi } from "vitest";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { BrowserRouteContext } from "../server-context.js";
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
