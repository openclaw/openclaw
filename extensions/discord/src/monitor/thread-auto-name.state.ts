import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getDiscordRuntime } from "../runtime.js";

export const DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS = 24 * 60 * 60_000;
export const DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS = 10 * 60_000;
const MAX_ENTRIES = 10_000;

export class DiscordThreadAutoNameState {
  private readonly claimedStore: PluginStateKeyedStore<boolean, 2>;
  private readonly rateStore: PluginStateKeyedStore<number[], 2>;
  private initialization: Promise<boolean> | undefined;

  constructor(
    private readonly params: {
      accountId: string;
      claimedStore?: PluginStateKeyedStore<boolean, 2>;
      rateStore?: PluginStateKeyedStore<number[], 2>;
      nowMs?: () => number;
    },
  ) {
    this.claimedStore =
      params.claimedStore ??
      getDiscordRuntime().state.openKeyedStoreV2<boolean>({
        namespace: "thread-auto-name-claims",
        maxEntries: MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS,
      });
    this.rateStore =
      params.rateStore ??
      getDiscordRuntime().state.openKeyedStoreV2<number[]>({
        namespace: "thread-auto-name-rate",
        maxEntries: MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS,
      });
  }

  initialize(): Promise<boolean> {
    this.initialization ??= this.initializeClaims().catch(() => {
      logVerbose("discord: thread auto-name claim initialization failed");
      return false;
    });
    return this.initialization;
  }

  async hasClaim(threadId: string): Promise<boolean> {
    if (!(await this.initialize())) {
      return true;
    }
    try {
      return (await this.claimedStore.lookup(this.key(threadId))) === true;
    } catch {
      logVerbose("discord: thread auto-name claim lookup failed");
      return true;
    }
  }

  async claim(threadId: string): Promise<boolean> {
    if (!(await this.initialize())) {
      return false;
    }
    try {
      return await this.claimedStore.registerIfAbsent(this.key(threadId), true, {
        ttlMs: DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS,
      });
    } catch {
      logVerbose("discord: thread auto-name claim registration failed");
      return false;
    }
  }

  async deleteClaim(threadId: string): Promise<void> {
    if (!(await this.initialize())) {
      return;
    }
    try {
      await this.claimedStore.delete(this.key(threadId));
    } catch {
      logVerbose("discord: thread auto-name claim deletion failed");
    }
  }

  async reserveRename(parentId: string): Promise<boolean> {
    if (!(await this.initialize())) {
      return false;
    }
    try {
      const key = this.key(parentId);
      let observed = await this.rateStore.observe(key);
      for (;;) {
        const now = this.now();
        const recent = (observed.value ?? []).filter(
          (at) => now - at < DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS,
        );
        if (recent.length >= 2) {
          return false;
        }
        const result = await this.rateStore.compareAndApply(key, observed.comparison, {
          operation: "update",
          action: "set",
          value: [...recent, now],
          ttlMs: DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS,
        });
        if (result.status !== "conflict") {
          return result.status === "applied";
        }
        observed = result.current;
      }
    } catch {
      logVerbose("discord: thread auto-name rename budget unavailable");
      return false;
    }
  }

  private async initializeClaims(): Promise<boolean> {
    const entries = await this.claimedStore.entries();
    for (const entry of entries) {
      if (entry.expiresAt !== undefined) {
        continue;
      }
      // Read metadata after the observation so its comparison protects the repair,
      // including against another initializer or a replacement claim.
      for (;;) {
        const observed = await this.claimedStore.observe(entry.key);
        const [current] = await this.claimedStore.entriesInKeyRange({
          keyStartInclusive: entry.key,
          keyEndExclusive: `${entry.key}\0`,
          limit: 1,
        });
        if (!current || current.expiresAt !== undefined) {
          break;
        }
        const remainingTtlMs =
          current.createdAt + DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS - this.now();
        const result = await this.claimedStore.compareAndApply(
          entry.key,
          observed.comparison,
          remainingTtlMs <= 0
            ? { operation: "delete", action: "delete" }
            : { operation: "update", action: "set", value: current.value, ttlMs: remainingTtlMs },
        );
        if (result.status !== "conflict") {
          break;
        }
      }
    }
    return true;
  }

  private key(id: string): string {
    return `${this.params.accountId}:${id}`;
  }

  private now(): number {
    return this.params.nowMs?.() ?? Date.now();
  }
}
