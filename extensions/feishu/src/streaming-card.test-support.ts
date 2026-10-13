import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { vi } from "vitest";
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
