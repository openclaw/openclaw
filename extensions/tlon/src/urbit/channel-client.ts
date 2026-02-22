import { randomUUID } from "node:crypto";
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk";
import { ensureUrbitChannelOpen, pokeUrbitChannel, scryUrbitPath } from "./channel-ops.js";
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

    const channelId = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`;
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
    const channelId = this.channelId;
    if (!channelId) {
      throw new Error("Channel not opened");
    }
    return await pokeUrbitChannel(
      {
        baseUrl: this.baseUrl,
        cookie: this.cookie,
        ship: this.ship,
        channelId,
        ssrfPolicy: this.ssrfPolicy,
        lookupFn: this.lookupFn,
        fetchImpl: this.fetchImpl,
      },
      { ...params, auditContext: "tlon-urbit-poke" },
    );
  }

  async scry(path: string): Promise<unknown> {
    return await scryUrbitPath(
      {
        baseUrl: this.baseUrl,
        cookie: this.cookie,
        ssrfPolicy: this.ssrfPolicy,
        lookupFn: this.lookupFn,
        fetchImpl: this.fetchImpl,
      },
      { path, auditContext: "tlon-urbit-scry" },
    );
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
