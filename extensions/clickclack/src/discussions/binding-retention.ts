import { isDeepStrictEqual } from "node:util";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  readDiscussionSessionEntry,
  type ClickClackDiscussionBinding,
  type ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { markClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";

export class DetachedDiscussionBindingRetention {
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #maxRetained: number;

  constructor(options: {
    runtime: PluginRuntime;
    store: ClickClackDiscussionBindingStore;
    maxRetained: number;
  }) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#maxRetained = options.maxRetained;
  }

  async mark(sessionKey: string, binding: ClickClackDiscussionBinding): Promise<void> {
    const current = await this.#store.getAsync(sessionKey);
    if (!current || !isDeepStrictEqual(current, binding)) {
      return;
    }
    if (current.detachedAt === undefined) {
      await this.#store.setIfCurrent(
        sessionKey,
        current,
        { ...current, detachedAt: Date.now() },
        {
          assertCurrent: () => this.#assertDetached(sessionKey, current),
        },
      );
    }
    while (this.#store.detachedCount() > this.#maxRetained) {
      if (!(await this.#pruneOldest())) {
        throw new Error("ClickClack detached discussion binding retention could not be reduced");
      }
    }
  }

  async clear(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<ClickClackDiscussionBinding | undefined> {
    const current = await this.#store.getAsync(sessionKey);
    if (!current || !isDeepStrictEqual(current, binding)) {
      return undefined;
    }
    if (current.detachedAt === undefined) {
      return current;
    }
    const { detachedAt: _detachedAt, ...retained } = current;
    const applied = await this.#store.setIfCurrent(sessionKey, current, retained, {
      assertCurrent: () => this.#assertRoomCurrent(sessionKey, current),
    });
    return applied ? retained : undefined;
  }

  async ensureCapacity(sessionKey: string): Promise<void> {
    await this.#store.prepare();
    while (!(await this.#store.hasCapacity(sessionKey))) {
      if (!(await this.#pruneOldest())) {
        throw new Error("ClickClack discussion binding capacity is exhausted");
      }
    }
  }

  async #pruneOldest(): Promise<boolean> {
    for (;;) {
      const oldest = await this.#store.oldestDetached();
      if (!oldest) {
        return false;
      }
      const current = oldest.binding;
      const entry = await readDiscussionSessionEntry(this.#runtime, oldest.sessionKey);
      if (entry) {
        await this.clear(oldest.sessionKey, current);
        continue;
      }
      const authority = {
        assertCurrent: () => this.#assertDetached(oldest.sessionKey, current),
      };
      if (
        !(await markClickClackDiscussionChannelRevoked(
          this.#runtime,
          oldest.sessionKey,
          current,
          authority,
        ))
      ) {
        continue;
      }
      if (await this.#store.deleteIfCurrent(oldest.sessionKey, current, authority)) {
        return true;
      }
    }
  }

  #sameRoom(left: ClickClackDiscussionBinding, right: ClickClackDiscussionBinding): boolean {
    return (
      left.serverBaseUrl === right.serverBaseUrl &&
      left.channelId === right.channelId &&
      left.externalRef === right.externalRef
    );
  }

  #assertRoomCurrent(sessionKey: string, expected: ClickClackDiscussionBinding): void {
    const current = this.#store.get(sessionKey);
    if (!current || !this.#sameRoom(current, expected)) {
      throw new Error("ClickClack discussion binding changed before retention committed");
    }
  }

  #assertDetached(sessionKey: string, expected: ClickClackDiscussionBinding): void {
    this.#assertRoomCurrent(sessionKey, expected);
    if (this.#runtime.agent.session.getSessionEntry({ sessionKey, readConsistency: "latest" })) {
      throw new Error("ClickClack discussion session returned before retention committed");
    }
  }
}
