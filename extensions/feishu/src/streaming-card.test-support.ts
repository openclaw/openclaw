import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
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

const HERMETIC_PUBLIC_LOOKUP_ADDRESS = "93.184.216.34";

export const hermeticPublicLookup: LookupFn = async () => [
  { address: HERMETIC_PUBLIC_LOOKUP_ADDRESS, family: 4 },
];

export function createMemoryFetch(
  handler: (url: URL, body: string) => Response | Promise<Response>,
): StreamingFetchDeps {
  return {
    fetchImpl: withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = typeof init?.body === "string" ? init.body : "";
        return await handler(url, body);
      }),
    ) as typeof fetch,
    lookupFn: hermeticPublicLookup,
  };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function mockAcceptedStreamingCard(params: {
  accountId: string;
  response?: { code: number; msg: string; data?: { message_id?: string } };
  rejectClose?: boolean;
  rejectClear?: boolean;
}) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const deps = createMemoryFetch((url, body) => {
    if (url.pathname.includes("/auth/")) {
      return jsonResponse({
        code: 0,
        msg: "ok",
        tenant_access_token: "token",
        expire: 7200,
      });
    }
    if (url.pathname.endsWith("/cardkit/v1/cards")) {
      return jsonResponse({ code: 0, msg: "ok", data: { card_id: "card_accepted" } });
    }
    requests.push({ path: url.pathname, body: JSON.parse(body) as Record<string, unknown> });
    return jsonResponse(
      params.rejectClose && url.pathname.endsWith("/settings")
        ? { code: 91400, msg: "close rejected" }
        : params.rejectClear && url.pathname.endsWith("/elements/content")
          ? { code: 19002, msg: "clear rejected" }
          : { code: 0, msg: "ok" },
    );
  });
  const response = params.response ?? { code: 0, msg: "ok", data: {} };
  const create = vi.fn(async () => response);
  const reply = vi.fn(async () => response);
  const remove = vi.fn(async () => ({ code: 0, msg: "ok" }));
  const client = {
    im: { message: { create, reply, delete: remove } },
  } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];
  const session = createStreamingSession(
    client,
    { appId: params.accountId, appSecret: "test-secret" },
    undefined,
    deps,
  );
  return { session, requests, create, reply, remove };
}
