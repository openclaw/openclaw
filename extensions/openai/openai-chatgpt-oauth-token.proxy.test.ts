import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const directLookup = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("direct DNS selected");
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, lookupFn: directLookup }),
  };
});

import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";

afterEach(() => {
  directLookup.mockClear();
  vi.unstubAllEnvs();
});

it.each([
  ["exchange", "HTTPS_PROXY", "HTTPS_PROXY", true],
  ["exchange", "HTTP_PROXY fallback", "HTTP_PROXY", true],
  ["exchange", "NO_PROXY bypass", "HTTPS_PROXY", false],
  ["exchange", "no configured proxy", undefined, false],
  ["exchange", "ALL_PROXY alone", "ALL_PROXY", false],
  ["exchange", "empty lowercase override", "HTTPS_PROXY", false],
  ["exchange", "managed proxy", "HTTPS_PROXY", true],
  ["exchange", "retired owner", "HTTPS_PROXY", false],
  ["exchange", "aborted caller", "HTTPS_PROXY", false],
  ["refresh", "HTTPS_PROXY", "HTTPS_PROXY", true],
  ["refresh", "aborted caller", "HTTPS_PROXY", false],
] as const)("preserves %s %s behavior", async (operation, name, variable, proxied) => {
  const aborted = name === "aborted caller";
  const retired = name === "retired owner";
  for (const key of [
    ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((proxyKey) => [
      proxyKey,
      proxyKey.toLowerCase(),
    ]),
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(key, undefined);
  }
  const destinations: string[] = [];
  const sockets = new Set<Duplex>();
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    destinations.push(request.url ?? "");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A rejected CONNECT proves proxy selection without contacting an auth service.
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP proxy address");
  }
  if (variable) {
    vi.stubEnv(variable, `http://127.0.0.1:${address.port}`);
  }
  vi.stubEnv("NO_PROXY", name === "NO_PROXY bypass" ? "auth.openai.com" : "");
  if (name === "empty lowercase override") {
    vi.stubEnv("https_proxy", "");
  }
  if (name === "managed proxy") {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
  }
  const signal = aborted ? AbortSignal.abort() : new AbortController().signal;
  const assertCurrent = vi.fn(() => {
    if (retired) {
      throw new Error("owner retired");
    }
  });
  const options = { signal, assertCurrent, timeoutMs: 1000 };

  try {
    const result =
      operation === "exchange"
        ? await exchangeOpenAIAuthorizationCode(
            "synthetic-code",
            "synthetic-verifier",
            "http://localhost:1455/auth/callback",
            options,
          )
        : await refreshOpenAIAccessToken("synthetic-refresh", options);

    expect(result).toMatchObject({
      type: "failed",
      operation,
      ...(aborted
        ? { cancelled: true, summary: "Login cancelled" }
        : retired || !proxied
          ? {
              summary: expect.stringContaining(retired ? "owner retired" : "direct DNS selected"),
            }
          : {}),
    });
    expect(destinations).toEqual(proxied ? ["auth.openai.com:443"] : []);
    if (aborted || retired || proxied) {
      expect(assertCurrent).toHaveBeenCalledTimes(aborted ? 0 : 1);
    }
    expect(directLookup).toHaveBeenCalledTimes(proxied || retired || aborted ? 0 : 1);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve());
    });
  }
});
