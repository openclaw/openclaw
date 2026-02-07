/**
 * Cloud Skill Store client.
 *
 * Iterates over configured trusted stores in order, fetching the manifest
 * or individual skill metadata.  Uses ETag/304 for bandwidth efficiency.
 */

import type { SkillStoreConfig } from "../../../src/config/types.skills.js";
import type { ManifestResponse, SingleSkillResponse } from "./types.js";

export type CloudClientOptions = {
  stores: SkillStoreConfig[];
  /** Custom fetch implementation (for testing / SSRF guard). */
  fetchImpl?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Defaults to 15 000. */
  timeoutMs?: number;
};

export class CloudClient {
  private stores: SkillStoreConfig[];
  private fetchFn: typeof globalThis.fetch;
  private timeoutMs: number;

  constructor(opts: CloudClientOptions) {
    this.stores = opts.stores;
    this.fetchFn = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Fetch the full manifest from the first reachable trusted store.
   *
   * @param cachedVersion  Current cached version string (sent as If-None-Match).
   * @returns  The manifest if updated, `null` if 304, or throws on total failure.
   */
  async fetchManifest(cachedVersion?: string): Promise<ManifestResponse | null> {
    const errors: Error[] = [];

    for (const store of this.stores) {
      try {
        const result = await this.fetchManifestFromStore(store, cachedVersion);
        return result;
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    throw new AggregateError(errors, `all ${this.stores.length} trusted store(s) unreachable`);
  }

  /**
   * Query a single skill from the first reachable trusted store.
   *
   * @returns  The skill info, or `null` if the skill is not in any store (404).
   */
  async fetchSingleSkill(name: string): Promise<SingleSkillResponse | null> {
    const errors: Error[] = [];

    for (const store of this.stores) {
      try {
        const url = `${store.url.replace(/\/+$/, "")}/skills/${encodeURIComponent(name)}`;
        const res = await this.doFetch(url, store.apiKey);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`store ${store.name ?? store.url}: HTTP ${res.status}`);
        return (await res.json()) as SingleSkillResponse;
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    throw new AggregateError(errors, `all stores unreachable when querying skill "${name}"`);
  }

  // ── private ──────────────────────────────────────────────

  private async fetchManifestFromStore(
    store: SkillStoreConfig,
    cachedVersion?: string,
  ): Promise<ManifestResponse | null> {
    const url = `${store.url.replace(/\/+$/, "")}/manifest`;
    const headers: Record<string, string> = {};
    if (cachedVersion) {
      headers["If-None-Match"] = `"${cachedVersion}"`;
    }

    const res = await this.doFetch(url, store.apiKey, headers);

    if (res.status === 304) return null;
    if (!res.ok) {
      throw new Error(`store ${store.name ?? store.url}: HTTP ${res.status}`);
    }

    return (await res.json()) as ManifestResponse;
  }

  private async doFetch(
    url: string,
    apiKey?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
