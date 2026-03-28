import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError, type LookupFn } from "../infra/net/ssrf.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirects,
  withRequestTimeBrowserNavigationGuard,
} from "./navigation-guard.js";

function createLookupFn(address: string): LookupFn {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

describe("browser navigation guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks private loopback URLs by default", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://127.0.0.1:8080",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows about:blank", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:blank",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks file URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks data URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "data:text/html,<h1>owned</h1>",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks javascript URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "javascript:alert(1)",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks non-blank about URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:srcdoc",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("allows blocked hostnames when explicitly allowed", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://agent.internal:3000",
        ssrfPolicy: {
          allowedHostnames: ["agent.internal"],
        },
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("agent.internal", { all: true });
  });

  it("blocks hostnames that resolve to private addresses by default", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows hostnames that resolve to public addresses", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks strict policy navigation when env proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("allows env proxy navigation when private-network mode is explicitly enabled", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "not a url",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("validates final network URLs after navigation", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "http://private.test",
        lookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("ignores non-network browser-internal final URLs", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "chrome-error://chromewebdata/",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks private intermediate redirect hops", async () => {
    const publicLookup = createLookupFn("93.184.216.34");
    const privateLookup = createLookupFn("127.0.0.1");
    const finalRequest = {
      url: () => "https://public.example/final",
      redirectedFrom: () => ({
        url: () => "http://private.example/internal",
        redirectedFrom: () => ({
          url: () => "https://public.example/start",
          redirectedFrom: () => null,
        }),
      }),
    };

    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: finalRequest,
        lookupFn: vi.fn(async (hostname: string) =>
          hostname === "private.example"
            ? privateLookup(hostname, { all: true })
            : publicLookup(hostname, { all: true }),
        ) as unknown as LookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows redirect chains when every hop is public", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const finalRequest = {
      url: () => "https://public.example/final",
      redirectedFrom: () => ({
        url: () => "https://public.example/middle",
        redirectedFrom: () => ({
          url: () => "https://public.example/start",
          redirectedFrom: () => null,
        }),
      }),
    };

    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: finalRequest,
        lookupFn,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats default browser SSRF mode as requiring redirect-hop inspection", () => {
    expect(requiresInspectableBrowserNavigationRedirects()).toBe(true);
    expect(requiresInspectableBrowserNavigationRedirects({ allowPrivateNetwork: true })).toBe(
      false,
    );
  });

  it("blocks private main-frame redirect requests before continuation", async () => {
    let handler:
      | ((
          route: { abort: () => Promise<void>; continue: () => Promise<void> },
          request: {
            url: () => string;
            isNavigationRequest: () => boolean;
            frame: () => { parentFrame: () => null };
          },
        ) => Promise<void>)
      | undefined;
    const routeContinue = vi.fn(async () => {});
    const routeAbort = vi.fn(async () => {});
    const page = {
      route: vi.fn(async (_matcher: string, nextHandler: typeof handler) => {
        handler = nextHandler;
      }),
      unroute: vi.fn(async () => {}),
    };

    await expect(
      withRequestTimeBrowserNavigationGuard({
        page,
        navigate: async () => {
          await handler?.(
            { abort: routeAbort, continue: routeContinue },
            {
              url: () => "https://93.184.216.34/start",
              isNavigationRequest: () => true,
              frame: () => ({ parentFrame: () => null }),
            },
          );
          await handler?.(
            { abort: routeAbort, continue: routeContinue },
            {
              url: () => "http://127.0.0.1:18080/internal-hop",
              isNavigationRequest: () => true,
              frame: () => ({ parentFrame: () => null }),
            },
          );
          return "done";
        },
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(routeContinue).toHaveBeenCalledTimes(1);
    expect(routeAbort).toHaveBeenCalledTimes(1);
    expect(page.unroute).toHaveBeenCalledTimes(1);
  });

  it("ignores non-navigation requests in the request-time guard", async () => {
    let handler:
      | ((
          route: { abort: () => Promise<void>; continue: () => Promise<void> },
          request: {
            url: () => string;
            isNavigationRequest: () => boolean;
            frame: () => { parentFrame: () => null };
          },
        ) => Promise<void>)
      | undefined;
    const routeContinue = vi.fn(async () => {});
    const routeAbort = vi.fn(async () => {});
    const page = {
      route: vi.fn(async (_matcher: string, nextHandler: typeof handler) => {
        handler = nextHandler;
      }),
      unroute: vi.fn(async () => {}),
    };

    const result = await withRequestTimeBrowserNavigationGuard({
      page,
      navigate: async () => {
        await handler?.(
          { abort: routeAbort, continue: routeContinue },
          {
            url: () => "http://127.0.0.1:18080/internal-asset",
            isNavigationRequest: () => false,
            frame: () => ({ parentFrame: () => null }),
          },
        );
        return "done";
      },
    });

    expect(result).toBe("done");
    expect(routeContinue).toHaveBeenCalledTimes(1);
    expect(routeAbort).not.toHaveBeenCalled();
  });

  it("ignores child-frame navigation requests in the request-time guard", async () => {
    let handler:
      | ((
          route: { abort: () => Promise<void>; continue: () => Promise<void> },
          request: {
            url: () => string;
            isNavigationRequest: () => boolean;
            frame: () => { parentFrame: () => Record<string, unknown> };
          },
        ) => Promise<void>)
      | undefined;
    const routeContinue = vi.fn(async () => {});
    const routeAbort = vi.fn(async () => {});
    const page = {
      route: vi.fn(async (_matcher: string, nextHandler: typeof handler) => {
        handler = nextHandler;
      }),
      unroute: vi.fn(async () => {}),
    };

    const result = await withRequestTimeBrowserNavigationGuard({
      page,
      navigate: async () => {
        await handler?.(
          { abort: routeAbort, continue: routeContinue },
          {
            url: () => "http://127.0.0.1:18080/iframe-hop",
            isNavigationRequest: () => true,
            frame: () => ({ parentFrame: () => ({}) }),
          },
        );
        return "done";
      },
    });

    expect(result).toBe("done");
    expect(routeContinue).toHaveBeenCalledTimes(1);
    expect(routeAbort).not.toHaveBeenCalled();
  });
});
