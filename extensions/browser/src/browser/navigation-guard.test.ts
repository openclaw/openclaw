import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SsrFBlockedError, type LookupFn } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
} from "./navigation-guard.js";

function createLookupFn(address: string): LookupFn {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((key) => [
  key,
  key.toLowerCase(),
]);

function strictPolicy(allowedHostnames: string[]) {
  return { dangerouslyAllowPrivateNetwork: false, allowedHostnames };
}

function checkHostname(hostname: string, pattern: string, lookupFn: LookupFn) {
  return assertBrowserNavigationAllowed({
    url: `https://${hostname}`,
    lookupFn,
    ssrfPolicy: strictPolicy([pattern]),
  });
}

type Request = Parameters<typeof assertBrowserNavigationRedirectChainAllowed>[0]["request"];
function redirectChain(...urls: string[]): Request {
  return urls.reduce<Request>(
    (previous, url) => ({ url: () => url, redirectedFrom: () => previous ?? null }),
    null,
  );
}

describe("browser navigation guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["http://127.0.0.1:8080", SsrFBlockedError],
    ["https://example.com", SsrFBlockedError],
    ["file:///etc/passwd", InvalidBrowserNavigationUrlError],
    ["about:srcdoc", InvalidBrowserNavigationUrlError],
    ["not a url", InvalidBrowserNavigationUrlError],
  ] as const)("rejects navigation to %s", async (url, error) => {
    const lookupFn = url === "https://example.com" ? createLookupFn("127.0.0.1") : undefined;
    await expect(assertBrowserNavigationAllowed({ url, lookupFn })).rejects.toBeInstanceOf(error);
  });

  it("allows about:blank", async () => {
    await expect(assertBrowserNavigationAllowed({ url: "about:blank" })).resolves.toBeUndefined();
  });

  it.each([
    { name: "requested navigation", check: assertBrowserNavigationAllowed },
    { name: "final URL", check: assertBrowserNavigationResultAllowed },
    {
      name: "redirect chain",
      check: (options: Parameters<typeof assertBrowserNavigationAllowed>[0]) =>
        assertBrowserNavigationRedirectChainAllowed({
          ...options,
          request: redirectChain("https://example.com/start", options.url),
        }),
    },
  ])("cancels a stalled $name DNS check without waiting for lookup", async ({ check }) => {
    const lookup = createDeferred<Awaited<ReturnType<LookupFn>>>();
    const lookupFn = vi.fn<LookupFn>(() => lookup.promise);
    const controller = new AbortController();
    const reason = new Error("browser action deadline expired");
    const rejected = vi.fn();
    const options = {
      url: "https://example.com/final",
      lookupFn,
      signal: controller.signal,
    };
    const completion = check(options).catch((error: unknown) => {
      rejected(error);
      return error;
    });
    try {
      expect(lookupFn).toHaveBeenCalledOnce();

      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(rejected).toHaveBeenCalledWith(reason);
      expect(await completion).toBe(reason);
    } finally {
      lookup.resolve([{ address: "93.184.216.34", family: 4 }]);
      await completion;
    }
  });

  it.each([
    ["agent.internal", "agent.internal", "10.0.0.1"],
    ["sub.example.com", "*.example.com", "93.184.216.34"],
  ])("allows strict-mode hostname %s through %s", async (hostname, pattern, address) => {
    const lookupFn = createLookupFn(address);
    await expect(checkHostname(hostname, pattern, lookupFn)).resolves.toBeUndefined();
  });

  it.each(["example.com", "evil-example.com"])(
    "does not match %s against a wildcard allowlist entry",
    async (hostname) => {
      const lookupFn = createLookupFn("93.184.216.34");
      await expect(checkHostname(hostname, "*.example.com", lookupFn)).rejects.toThrow(
        /dns rebinding protections are unavailable/i,
      );
      expect(lookupFn).not.toHaveBeenCalled();
    },
  );

  it("allows public navigation when only Gateway env proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({ url: "https://example.com", lookupFn }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it.each([false, true])(
    "gates explicit browser proxy routing on private-network mode (%s)",
    async (allowed) => {
      const lookupFn = createLookupFn("93.184.216.34");
      const result = assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        browserProxyMode: "explicit-browser-proxy",
        ...(allowed ? { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } : {}),
      });
      if (allowed) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
        expect(lookupFn).not.toHaveBeenCalled();
      }
    },
  );

  it("blocks network URLs with embedded credentials before lookup", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const result = assertBrowserNavigationAllowed({
      url: "https://user:secret@example.com/private",
      lookupFn,
    });
    await expect(result).rejects.toThrow("URL-embedded credentials are not supported");
    await expect(result).rejects.toThrow("openclaw browser set credentials");
    await expect(result).rejects.not.toThrow("secret");
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("redacts malformed credential-bearing URLs from diagnostics", async () => {
    const result = assertBrowserNavigationAllowed({ url: "https://user:secret@" });
    await expect(result).rejects.toThrow("Invalid URL: [redacted credential-bearing URL]");
    await expect(result).rejects.not.toThrow("secret");
  });

  it("ignores non-network browser-internal final URLs", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({ url: "chrome-error://chromewebdata/" }),
    ).resolves.toBeUndefined();
  });

  it("blocks final hostname URLs in strict mode after navigation", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "https://example.com/final",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it.each([
    ["http://private.example/internal", true],
    ["https://public.example/middle", false],
  ] as const)("checks intermediate redirect %s", async (middle, blocked) => {
    const result = assertBrowserNavigationRedirectChainAllowed({
      request: redirectChain(
        "https://public.example/start",
        middle,
        "https://public.example/final",
      ),
      lookupFn: vi.fn(async (hostname: string) => [
        {
          address: hostname === "private.example" ? "127.0.0.1" : "93.184.216.34",
          family: 4,
        },
      ]) as unknown as LookupFn,
    });
    if (blocked) {
      await expect(result).rejects.toBeInstanceOf(SsrFBlockedError);
    } else {
      await expect(result).resolves.toBeUndefined();
    }
  });
});
