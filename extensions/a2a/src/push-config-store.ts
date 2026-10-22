import { randomUUID } from "node:crypto";
import { taskNotFound } from "./a2a-errors.js";
import type { A2aPushNotificationConfig } from "./a2a-model.js";

const A2A_MAX_CONFIGS_PER_TASK = 10;
const A2A_DEFAULT_PAGE_SIZE = 50;
const A2A_MAX_PAGE_SIZE = 100;

export type A2aPushConfigCreateParams = {
  taskId: string;
  url: string;
  id?: string;
  tenant?: string;
  token?: string;
  authentication?: A2aPushNotificationConfig["authentication"];
};

/**
 * In-memory push notification config registry.
 *
 * Configs are scoped to the peer that owns the task, so one peer can never read
 * or delete another peer's webhook registration.
 */
export class A2aPushConfigStore {
  /** taskId -> ownerPeer -> configs (insertion ordered) */
  readonly #configs = new Map<string, Map<string, A2aPushNotificationConfig[]>>();

  create(ownerPeer: string, params: A2aPushConfigCreateParams): A2aPushNotificationConfig {
    const bucket = this.#bucketFor(ownerPeer, true);
    const existing = bucket.get(params.taskId) ?? [];
    const config: A2aPushNotificationConfig = {
      // The specification treats `id` as a result of Create, not an input requirement.
      id: params.id?.trim() || randomUUID(),
      taskId: params.taskId,
      url: params.url,
      ...(params.tenant ? { tenant: params.tenant } : {}),
      ...(params.token ? { token: params.token } : {}),
      ...(params.authentication ? { authentication: params.authentication } : {}),
    };
    const withoutSameId = existing.filter((entry) => entry.id !== config.id);
    const next = [...withoutSameId, config];
    if (next.length > A2A_MAX_CONFIGS_PER_TASK) {
      // Bound per-task registrations: a peer could otherwise grow the store
      // without limit by replaying Create with fresh ids.
      next.splice(0, next.length - A2A_MAX_CONFIGS_PER_TASK);
    }
    bucket.set(params.taskId, next);
    return structuredClone(config);
  }

  get(ownerPeer: string, taskId: string, configId: string): A2aPushNotificationConfig {
    const match = (this.#bucketFor(ownerPeer)?.get(taskId) ?? []).find(
      (entry) => entry.id === configId,
    );
    if (!match) {
      throw taskNotFound("Push notification config not found", taskId);
    }
    return structuredClone(match);
  }

  list(
    ownerPeer: string,
    taskId: string,
    paging?: { pageSize?: number; pageToken?: string },
  ): {
    configs: A2aPushNotificationConfig[];
    nextPageToken: string;
    pageSize: number;
  } {
    const all = this.#bucketFor(ownerPeer)?.get(taskId) ?? [];
    const requested = paging?.pageSize ?? A2A_DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(Math.trunc(requested) || A2A_DEFAULT_PAGE_SIZE, 1),
      A2A_MAX_PAGE_SIZE,
    );
    const startIndex = paging?.pageToken
      ? all.findIndex((entry) => entry.id === paging.pageToken) + 1
      : 0;
    const safeStart = Math.max(startIndex, 0);
    const page = all.slice(safeStart, safeStart + pageSize);
    // The cursor is the last id the caller already saw; see A2aTaskStore.listTasks.
    const lastIncluded = page.at(-1);
    const hasMore = safeStart + pageSize < all.length;
    return {
      configs: page.map((entry) => structuredClone(entry)),
      nextPageToken: hasMore && lastIncluded ? lastIncluded.id : "",
      pageSize: page.length,
    };
  }

  delete(ownerPeer: string, taskId: string, configId: string): void {
    const bucket = this.#bucketFor(ownerPeer);
    const existing = bucket?.get(taskId);
    if (!bucket || !existing) {
      // §3.1.10: deletion MUST be idempotent — "multiple deletions of the same
      // config have the same effect". A repeat delete already achieved the
      // requested end state, so it is a success, not a not-found error.
      return;
    }
    const next = existing.filter((entry) => entry.id !== configId);
    if (next.length === existing.length) {
      return;
    }
    if (next.length === 0) {
      bucket.delete(taskId);
    } else {
      bucket.set(taskId, next);
    }
  }

  /** Configs to notify for one task event, resolved without leaking other peers. */
  forTask(ownerPeer: string, taskId: string): A2aPushNotificationConfig[] {
    return (this.#bucketFor(ownerPeer)?.get(taskId) ?? []).map((entry) => structuredClone(entry));
  }

  deleteForTask(ownerPeer: string, taskId: string): void {
    this.#bucketFor(ownerPeer)?.delete(taskId);
  }

  clear(): void {
    this.#configs.clear();
  }

  #bucketFor(ownerPeer: string, create = false): Map<string, A2aPushNotificationConfig[]> {
    const existing = this.#configs.get(ownerPeer);
    if (existing) {
      return existing;
    }
    const created = new Map<string, A2aPushNotificationConfig[]>();
    if (create) {
      this.#configs.set(ownerPeer, created);
    }
    return created;
  }
}
