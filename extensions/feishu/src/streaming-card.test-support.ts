import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";
import { stripDispatcher } from "./http.test-support.js";
import { FeishuStreamingSession } from "./streaming-card.js";

export type StreamingFetchDeps = {
  fetchImpl: typeof fetch;
  lookupFn: LookupFn;
};

const fetchWithSsrFGuard = ssrfRuntime.fetchWithSsrFGuard;

export function createStreamingSession(
  client: ConstructorParameters<typeof FeishuStreamingSession>[0],
  creds: ConstructorParameters<typeof FeishuStreamingSession>[1],
  log: ConstructorParameters<typeof FeishuStreamingSession>[2],
  deps: StreamingFetchDeps,
): FeishuStreamingSession {
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((params) =>
    fetchWithSsrFGuard({ ...params, ...deps }),
  );
  return new FeishuStreamingSession(client, creds, log);
}

export function createLocalRedirectFetch(
  port: number,
  onResponse?: (response: Response) => void,
): typeof fetch {
  const realFetch = globalThis.fetch.bind(globalThis);
  return withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "open.feishu.cn" || url.hostname === "open.larksuite.com") {
      const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
      const response = await realFetch(loopback, stripDispatcher(init));
      onResponse?.(response);
      return response;
    }
    return await realFetch(input, init);
  });
}
