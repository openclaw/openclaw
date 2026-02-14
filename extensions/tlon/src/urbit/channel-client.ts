import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk";
import { ensureUrbitChannelOpen } from "./channel-ops.js";
import { getUrbitContext, normalizeUrbitCookie } from "./context.js";
import { urbitFetch } from "./fetch.js";

export type UrbitChannelClientOptions = {
  ship?: string;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export class UrbitChannelClient {
  readonly baseUrl: string;
  readonly cookie: string;
  readonly ship: string;
  readonly ssrfPolicy?: SsrFPolicy;
  readonly lookupFn?: LookupFn;
  readonly fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  private channelId: string | null = null;

  constructor(url: string, cookie: string, options: UrbitChannelClientOptions = {}) {
    const ctx = getUrbitContext(url, options.ship);
    this.baseUrl = ctx.baseUrl;
    this.cookie = normalizeUrbitCookie(cookie);
    this.ship = ctx.ship;
    this.ssrfPolicy = options.ssrfPolicy;
    this.lookupFn = options.lookupFn;
    this.fetchImpl = options.fetchImpl;
  }

  private get channelPath(): string {
    const id = this.channelId;
    if (!id) {
      throw new Error("Channel not opened");
    }
    return `/~/channel/${id}`;
  }

  async open(): Promise<void> {
    if (this.channelId) {
      return;
    }

    const channelId = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).substring(2, 8)}`;
    this.channelId = channelId;

    try {
      await ensureUrbitChannelOpen(
        {
          baseUrl: this.baseUrl,
          cookie: this.cookie,
          ship: this.ship,
          channelId,
          ssrfPolicy: this.ssrfPolicy,
          lookupFn: this.lookupFn,
          fetchImpl: this.fetchImpl,
        },
        {
          createBody: [],
          createAuditContext: "tlon-urbit-channel-open",
        },
      );
    } catch (error) {
      this.channelId = null;
      throw error;
    }
  }

  async poke(params: { app: string; mark: string; json: unknown }): Promise<number> {
    await this.open();
    const pokeId = Date.now();
    const pokeData = {
      id: pokeId,
      action: "poke",
      ship: this.ship,
      app: params.app,
      mark: params.mark,
      json: params.json,
    };

    const { response, release } = await urbitFetch({
      baseUrl: this.baseUrl,
      path: this.channelPath,
      init: {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
        },
        body: JSON.stringify([pokeData]),
      },
      ssrfPolicy: this.ssrfPolicy,
      lookupFn: this.lookupFn,
      fetchImpl: this.fetchImpl,
      timeoutMs: 30_000,
      auditContext: "tlon-urbit-poke",
    });

    try {
      if (!response.ok && response.status !== 204) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Poke failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`);
      }
      return pokeId;
    } finally {
      await release();
    }
  }

  async scry(path: string): Promise<unknown> {
    const scryPath = `/~/scry${path}`;
    const { response, release } = await urbitFetch({
      baseUrl: this.baseUrl,
      path: scryPath,
      init: {
        method: "GET",
        headers: { Cookie: this.cookie },
      },
      ssrfPolicy: this.ssrfPolicy,
      lookupFn: this.lookupFn,
      fetchImpl: this.fetchImpl,
      timeoutMs: 30_000,
      auditContext: "tlon-urbit-scry",
    });

    try {
      if (!response.ok) {
        throw new Error(`Scry failed: ${response.status} for path ${path}`);
      }
      return await response.json();
    } finally {
      await release();
    }
  }

  async getOurName(): Promise<string> {
    const { response, release } = await urbitFetch({
      baseUrl: this.baseUrl,
      path: "/~/name",
      init: {
        method: "GET",
        headers: { Cookie: this.cookie },
      },
      ssrfPolicy: this.ssrfPolicy,
      lookupFn: this.lookupFn,
      fetchImpl: this.fetchImpl,
      timeoutMs: 30_000,
      auditContext: "tlon-urbit-name",
    });

    try {
      if (!response.ok) {
        throw new Error(`Name request failed: ${response.status}`);
      }
      const text = await response.text();
      return text.trim();
    } finally {
      await release();
    }
  }

  async close(): Promise<void> {
    if (!this.channelId) {
      return;
    }
    const channelPath = this.channelPath;
    this.channelId = null;

    try {
      const { response, release } = await urbitFetch({
        baseUrl: this.baseUrl,
        path: channelPath,
        init: { method: "DELETE", headers: { Cookie: this.cookie } },
        ssrfPolicy: this.ssrfPolicy,
        lookupFn: this.lookupFn,
        fetchImpl: this.fetchImpl,
        timeoutMs: 30_000,
        auditContext: "tlon-urbit-channel-close",
      });
      try {
        void response.body?.cancel();
      } finally {
        await release();
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
