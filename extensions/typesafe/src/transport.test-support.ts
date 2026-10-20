import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import plugin from "../index.js";

export function mockFetch(implementation: typeof globalThis.fetch) {
  const fetch = vi.fn(implementation);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
export const mockResponse = (body?: BodyInit | null, init?: ResponseInit) =>
  mockFetch(async () => new Response(body, init));
export const mockJsonResponse = (body: unknown, init?: ResponseInit) =>
  mockResponse(typeof body === "string" ? body : JSON.stringify(body), init);
export const decisionContext = (model: string, budget = 1000) => ({
  model,
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + budget,
});
export function stubAmbientProxies() {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(key, "http://127.0.0.1:1");
    vi.stubEnv(key.toLowerCase(), "http://127.0.0.1:1");
  }
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "false");
}
export function collectRequest(request: IncomingMessage, handle: (body: string) => void) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    handle(Buffer.concat(chunks).toString("utf8"));
  });
}

export const choiceAnswer = (
  choice: string,
  probabilities: Record<string, number>,
  confidence: number,
) => ({ type: "choice" as const, choice, confidence, probabilities });
export const scoreAnswer = (
  score: number,
  probabilities: Record<string, number>,
  legend: Record<string, unknown>,
  confidence: number,
) => ({ type: "score" as const, score, confidence, probabilities, legend });
export const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

export function registeredDecisionProvider(
  current: () => ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
) {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  assert(provider);
  if (provider.contractVersion !== 1) {
    throw new Error("TypeSafe fixture registered an unexpected decision contract");
  }
  return provider;
}
