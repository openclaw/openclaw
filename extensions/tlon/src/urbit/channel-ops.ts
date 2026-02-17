import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk";
import { UrbitHttpError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

export type UrbitChannelDeps = {
  baseUrl: string;
  cookie: string;
  ship: string;
  channelId: string;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export async function createUrbitChannel(
  deps: UrbitChannelDeps,
  params: { body: unknown; auditContext: string },
): Promise<void> {
  const { response, release } = await urbitFetch({
    baseUrl: deps.baseUrl,
    path: `/~/channel/${deps.channelId}`,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: deps.cookie,
      },
      body: JSON.stringify(params.body),
    },
    ssrfPolicy: deps.ssrfPolicy,
    lookupFn: deps.lookupFn,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 30_000,
    auditContext: params.auditContext,
  });

  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel creation", status: response.status });
    }
  } finally {
    await release();
  }
}

export async function wakeUrbitChannel(deps: UrbitChannelDeps): Promise<void> {
  const { response, release } = await urbitFetch({
    baseUrl: deps.baseUrl,
    path: `/~/channel/${deps.channelId}`,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: deps.cookie,
      },
      body: JSON.stringify([
        {
          id: Date.now(),
          action: "poke",
          ship: deps.ship,
          app: "hood",
          mark: "helm-hi",
          json: "Opening API channel",
        },
      ]),
    },
    ssrfPolicy: deps.ssrfPolicy,
    lookupFn: deps.lookupFn,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 30_000,
    auditContext: "tlon-urbit-channel-wake",
  });

  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel activation", status: response.status });
    }
  } finally {
    await release();
  }
}

export async function ensureUrbitChannelOpen(
  deps: UrbitChannelDeps,
  params: { createBody: unknown; createAuditContext: string },
): Promise<void> {
  await createUrbitChannel(deps, {
    body: params.createBody,
    auditContext: params.createAuditContext,
  });
  await wakeUrbitChannel(deps);
}
