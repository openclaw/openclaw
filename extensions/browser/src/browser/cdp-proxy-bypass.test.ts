import http from "node:http";
import https from "node:https";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));
import {
  assertManagedProxyAllowsCdpUrl,
  getDirectAgentForCdp,
  withManagedProxyForCdpUrl,
  withNoProxyForCdpUrl,
} from "./cdp-proxy-bypass.js";

const cdpUrl = "http://127.0.0.1:9222";
const loopback = "localhost,127.0.0.1,[::1]";
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((key) => [
  key,
  key.toLowerCase(),
]);
let env: ReturnType<typeof captureEnv>;
beforeEach(() => {
  vi.useRealTimers();
  registerManagedProxyBrowserCdpBypassMock.mockReset();
  env = captureEnv([...proxyKeys, "NO_PROXY", "no_proxy"]);
  for (const key of [...proxyKeys, "NO_PROXY", "no_proxy"]) {
    delete process.env[key];
  }
  process.env.HTTP_PROXY = "http://proxy:8080";
});
afterEach(() => env.restore());

function expectBypass(upper: string | undefined, lower = upper) {
  expect([process.env.NO_PROXY, process.env.no_proxy]).toEqual([upper, lower]);
}

describe("cdp-proxy-bypass", () => {
  it.each([
    ["http://127.0.0.1:9222/json/version", http.Agent],
    ["wss://localhost:9222", https.Agent],
    ["https://127.0.0.1:9222/json/version", https.Agent],
    ["ws://[::1]:9222", http.Agent],
  ] as const)("uses a direct agent for %s", (url, Agent) => {
    expect(getDirectAgentForCdp(url)).toBeInstanceOf(Agent);
  });
  it.each(["http://remote-host:9222", "https://example.com:9222", "not-a-url"])(
    "does not supply a direct agent for %s",
    (url) => expect(getDirectAgentForCdp(url)).toBeUndefined(),
  );
  it("skips when no proxy env is set", async () => {
    delete process.env.HTTP_PROXY;
    await withNoProxyForCdpUrl(cdpUrl, async () => expectBypass(undefined));
  });
  it("restores env even on error", async () => {
    await expect(
      withNoProxyForCdpUrl(cdpUrl, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expectBypass(undefined);
  });
  it("does not mutate NO_PROXY for non-loopback CDP URLs", async () => {
    await withNoProxyForCdpUrl("https://browserless.example/chrome?token=abc", async () =>
      expectBypass(undefined),
    );
  });

  it.each(["first", "second"] as const)(
    "restores concurrent leases when %s caller exits first",
    async (firstExit) => {
      const enter = [createDeferred<void>(), createDeferred<void>()] as const;
      const release = [createDeferred<void>(), createDeferred<void>()] as const;
      const start = (index: 0 | 1) =>
        withNoProxyForCdpUrl(cdpUrl, async () => {
          expect(process.env.NO_PROXY).toContain("localhost");
          expect(process.env.NO_PROXY).toContain("[::1]");
          enter[index].resolve();
          await release[index].promise;
          return index;
        });
      const a = start(0);
      await enter[0].promise;
      const b = start(1);
      await enter[1].promise;
      const first = firstExit === "first" ? 0 : 1;
      const last = first === 0 ? 1 : 0;
      const calls = [a, b] as const;
      release[first].resolve();
      expect(await calls[first]).toBe(first);
      expect(process.env.NO_PROXY).toContain("localhost");
      release[last].resolve();
      expect(await calls[last]).toBe(last);
      expectBypass(undefined);
    },
  );

  const configured = `${loopback},myhost.internal`;
  const lookalikes = "notlocalhost,127.0.0.10,[::1].example";
  it.each([
    ["preserves complete entries", configured, configured, false],
    ["extends both casings when one is stale", configured, "myhost.internal", true],
    ["mirrors lowercase-only entries", undefined, "corp.internal", true],
    ["rejects substring matches", lookalikes, lookalikes, true],
  ] as const)("%s", async (_name, upper, lower, appended) => {
    if (upper !== undefined) {
      process.env.NO_PROXY = upper;
    }
    process.env.no_proxy = lower;
    await withNoProxyForCdpUrl(cdpUrl, async () => {
      expectBypass(
        appended ? `${upper || lower},${loopback}` : upper,
        appended ? `${lower},${loopback}` : lower,
      );
    });
    expectBypass(upper, lower);
  });
});

describe("withManagedProxyForCdpUrl", () => {
  let release = vi.fn<() => void>();
  beforeEach(() => {
    release = vi.fn<() => void>();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
  });
  it("registers the exact CDP URL and releases after the operation", () => {
    const url = `${cdpUrl}/json/version`;
    expect(withManagedProxyForCdpUrl(url, () => "ok")).toBe("ok");
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(url);
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases the exact CDP URL when the operation throws", () => {
    const url = "ws://127.0.0.1:9222/devtools/browser/abc";
    expect(() =>
      withManagedProxyForCdpUrl(url, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(url);
    expect(release).toHaveBeenCalledOnce();
  });
  it("keeps the exact CDP URL registered until an async operation settles", async () => {
    const deferred = createDeferred<string>();
    const result = withManagedProxyForCdpUrl(`${cdpUrl}/json/version`, () => deferred.promise);
    expect(release).not.toHaveBeenCalled();
    deferred.resolve("ok");
    await expect(result).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });
  it("uses the same scoped registration for launch policy preflight", () => {
    assertManagedProxyAllowsCdpUrl(cdpUrl);
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(cdpUrl);
    expect(release).toHaveBeenCalledOnce();
  });
});
