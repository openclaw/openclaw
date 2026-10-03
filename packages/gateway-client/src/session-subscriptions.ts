import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { generateUUID } from "@openclaw/normalization-core/uuid";
import {
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "./timeouts.js";

export type GatewaySessionMessageRequestClient = {
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T>;
};

export type GatewaySessionMessageSubscription = {
  key: string;
  agentId?: string | null;
  mode?: "narration";
  includeApprovals?: true;
  approvalReplay?: unknown;
};

export type GatewaySessionMessageSubscriptionOptions = {
  agentId?: string | null;
  mode?: "narration";
  includeApprovals?: boolean;
};

type SessionMessageSubscriptionResponse = {
  key: string;
  approvalReplay?: unknown;
};

type SessionMessageSubscriptionEntry = {
  subscriptionId: string;
  key: string;
  requestedKeys: Set<string>;
  agentId: string | null;
  scopeAgentId: string | null;
  ownerAgentId: string | null;
  ready: Promise<SessionMessageSubscriptionResponse>;
  approvalRequest: Promise<SessionMessageSubscriptionResponse> | null;
  plainFallback: Promise<SessionMessageSubscriptionResponse> | null;
  wireRequest: Promise<SessionMessageSubscriptionResponse> | null;
  mode?: "narration";
  includeApprovals: boolean;
  canonicalSettled: boolean;
  refreshRequired: boolean;
  handles: Set<GatewaySessionMessageSubscription>;
  pendingOwners: number;
  pendingFullOwners: number;
  release: Promise<void> | null;
  releasing?: GatewaySessionMessageSubscription;
};

type SessionMessageSubscriptionOwner = {
  coordinator: GatewaySessionMessageSubscriptionCoordinator;
  entry: SessionMessageSubscriptionEntry;
};

export type GatewaySessionMessageSubscriptionCoordinatorOptions = {
  keysEquivalent?: (left: string, right: string) => boolean;
};

function normalizedAgentScope(agentId: string | null): string | null {
  if (!agentId) {
    return null;
  }
  const normalized = normalizeAgentIdStrict(agentId);
  return normalized.ok ? normalized.value : agentId;
}

/**
 * Shared leases retain one wire observer ID. The Gateway combines independently
 * addressed observers; approval delivery upgrades the same owner.
 */
export class GatewaySessionMessageSubscriptionCoordinator {
  readonly #client: GatewaySessionMessageRequestClient;
  // Choose one matcher before the first lease; changing live aliases splits wire ownership.
  #keysEquivalent?: (left: string, right: string) => boolean;
  readonly #entries = new Set<SessionMessageSubscriptionEntry>();
  #retired = false;

  constructor(
    client: GatewaySessionMessageRequestClient,
    options: GatewaySessionMessageSubscriptionCoordinatorOptions = {},
  ) {
    this.#client = client;
    this.#keysEquivalent = options.keysEquivalent;
  }

  configure(options: GatewaySessionMessageSubscriptionCoordinatorOptions = {}): this {
    const matcher = options.keysEquivalent;
    if (!matcher || matcher === this.#keysEquivalent) {
      return this;
    }
    if (this.#keysEquivalent || this.#entries.size > 0) {
      throw new Error("Session message key equivalence cannot change for an active connection");
    }
    this.#keysEquivalent = matcher;
    return this;
  }

  async acquire(
    key: string,
    options: GatewaySessionMessageSubscriptionOptions = {},
  ): Promise<GatewaySessionMessageSubscription> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error("Session message subscription requires a session key");
    }
    const agentId = options.agentId?.trim() || null;
    const scopeAgentId = normalizedAgentScope(agentId);
    const narration = options.mode === "narration";
    const includeApprovals = options.includeApprovals === true;

    let entry: SessionMessageSubscriptionEntry;
    let created = false;
    while (true) {
      if (this.#retired) {
        throw new Error("Session message subscription belongs to a replaced Gateway connection");
      }
      const existing = [...this.#entries].find((candidate) => {
        return (
          candidate.scopeAgentId === scopeAgentId &&
          ([...candidate.requestedKeys].some((requestedKey) =>
            this.#areKeysEquivalent(requestedKey, normalizedKey),
          ) ||
            (candidate.key !== "global" && this.#areKeysEquivalent(candidate.key, normalizedKey)))
        );
      });
      if (!existing) {
        const provisional = [...this.#entries].find(
          (candidate) =>
            candidate.scopeAgentId === scopeAgentId &&
            !candidate.canonicalSettled &&
            this.#couldShareCanonicalIdentity(candidate.key, normalizedKey),
        );
        if (provisional) {
          await (provisional.plainFallback ?? provisional.ready).catch(() => undefined);
          continue;
        }
        entry = this.#createEntry(normalizedKey, agentId);
        created = true;
        break;
      }
      if (!existing.release) {
        entry = existing;
        entry.requestedKeys.add(normalizedKey);
        break;
      }
      // A final release must settle before a new owner decides whether the
      // same wire observer can be reused or must be subscribed again.
      await existing.release.catch(() => undefined);
    }

    entry.pendingOwners += 1;
    if (!narration) {
      entry.pendingFullOwners += 1;
    }
    try {
      if (created) {
        entry.ready = this.#requestSubscribe(entry, includeApprovals);
        if (includeApprovals) {
          entry.ready = this.#trackApprovalRequest(entry, entry.ready);
        }
        // Concurrent owners share this request without an unhandled side branch.
        void entry.ready.catch(() => undefined);
      }
      if (entry.refreshRequired) {
        entry.refreshRequired = false;
        entry.plainFallback = null;
        entry.approvalRequest = null;
        const retainedApprovals = [...entry.handles].some((handle) => handle.includeApprovals);
        // Refresh retained capabilities before applying a new owner's request;
        // plain fallback must not downgrade an existing approval observer.
        entry.ready = this.#requestSubscribe(entry, retainedApprovals).catch((error: unknown) => {
          entry.refreshRequired = true;
          throw error;
        });
      }
      const result = await this.#acquireCapability(entry, includeApprovals);
      if (!narration && entry.mode === "narration") {
        await this.#requestSubscribe(entry, false, "full");
      }
      if (this.#retired) {
        throw new Error("Session message subscription completed on a replaced Gateway connection");
      }

      const subscription: GatewaySessionMessageSubscription = {
        key: result.key,
        agentId,
        ...(narration ? { mode: "narration" as const } : {}),
        ...(includeApprovals
          ? {
              includeApprovals: true as const,
              ...(result.approvalReplay !== undefined
                ? { approvalReplay: result.approvalReplay }
                : {}),
            }
          : {}),
      };
      entry.handles.add(subscription);
      sessionMessageSubscriptionOwners.set(subscription, {
        coordinator: this,
        entry,
      });
      return subscription;
    } finally {
      entry.pendingOwners -= 1;
      if (!narration) {
        entry.pendingFullOwners -= 1;
      }
      if (entry.pendingOwners === 0 && entry.handles.size === 0 && !entry.release) {
        this.#entries.delete(entry);
      }
    }
  }

  release(subscription: GatewaySessionMessageSubscription): Promise<void> {
    const owner = sessionMessageSubscriptionOwners.get(subscription);
    if (!owner || owner.coordinator !== this) {
      return Promise.resolve();
    }
    const { entry } = owner;
    if (entry.release) {
      return entry.releasing === subscription
        ? entry.release
        : entry.release.catch(() => undefined).then(() => this.release(subscription));
    }
    const releasesLastFullOwner =
      subscription.mode !== "narration" &&
      [...entry.handles].every((handle) => handle === subscription || handle.mode === "narration");
    if (this.#retired || (entry.handles.size > 1 && !releasesLastFullOwner)) {
      this.#finishRelease(subscription, owner);
      return Promise.resolve();
    }
    if (entry.pendingOwners > 0) {
      // Keep the final live handle until every provisional owner commits or
      // fails; otherwise a rejected approval upgrade or acquire orphans it.
      const tracked = Promise.allSettled([
        entry.ready,
        entry.approvalRequest,
        entry.wireRequest,
      ]).then(() => {
        if (entry.release === tracked) {
          entry.release = null;
        }
        return this.release(subscription);
      });
      entry.release = tracked;
      entry.releasing = subscription;
      return tracked;
    }

    // Both downgrade and unsubscribe retain the lease until acknowledged, so
    // rejected releases remain retryable on their original owner.
    const removeEntry = entry.handles.size === 1;
    const request = removeEntry
      ? this.#requestMessages(entry).catch((error: unknown) => {
          if (error instanceof GatewayProtocolRequestTimeoutError && error.requestSent) {
            // The unsubscribe may have committed despite its missing acknowledgment.
            entry.refreshRequired = true;
          }
          throw error;
        })
      : this.#requestSubscribe(entry, false, "narration");
    const tracked = request
      .then(() => this.#finishRelease(subscription, owner, removeEntry))
      .finally(() => {
        if (entry.release === tracked) {
          entry.release = null;
        }
      });
    entry.release = tracked;
    entry.releasing = subscription;
    return tracked;
  }

  /** A reconnect retires leases without touching the next connection's observers. */
  reset(): void {
    this.#retired = true;
    for (const entry of this.#entries) {
      for (const subscription of entry.handles) {
        const owner = sessionMessageSubscriptionOwners.get(subscription);
        if (owner?.coordinator === this) {
          this.#finishRelease(subscription, owner);
        }
      }
    }
    this.#entries.clear();
  }

  #createEntry(key: string, agentId: string | null): SessionMessageSubscriptionEntry {
    const entry: SessionMessageSubscriptionEntry = {
      subscriptionId: generateUUID(),
      key,
      requestedKeys: new Set([key]),
      agentId,
      scopeAgentId: normalizedAgentScope(agentId),
      ownerAgentId: null,
      ready: Promise.resolve({ key }),
      approvalRequest: null,
      plainFallback: null,
      wireRequest: null,
      includeApprovals: false,
      canonicalSettled: false,
      refreshRequired: false,
      handles: new Set(),
      pendingOwners: 0,
      pendingFullOwners: 0,
      release: null,
    };
    this.#entries.add(entry);
    return entry;
  }

  #acquireCapability(
    entry: SessionMessageSubscriptionEntry,
    includeApprovals: boolean,
  ): Promise<SessionMessageSubscriptionResponse> {
    if (!includeApprovals) {
      if (entry.approvalRequest === entry.ready) {
        if (!entry.plainFallback) {
          const approvalRequest = entry.ready;
          // Approval authorization is stronger than transcript observation.
          // A concurrent plain owner must retry without approvals if the
          // first approval-only request is rejected by the Gateway.
          entry.plainFallback = approvalRequest.catch(async (error: unknown) => {
            if (this.#retired) {
              throw error;
            }
            const result = await this.#requestSubscribe(entry, false);
            entry.ready = Promise.resolve(result);
            if (entry.approvalRequest === approvalRequest) {
              entry.approvalRequest = null;
            }
            return result;
          });
        }
        return entry.plainFallback;
      }
      return entry.ready;
    }
    if (entry.approvalRequest) {
      return entry.approvalRequest;
    }

    return this.#trackApprovalRequest(
      entry,
      entry.ready.then(() => this.#requestSubscribe(entry, true)),
    );
  }

  #trackApprovalRequest(
    entry: SessionMessageSubscriptionEntry,
    request: Promise<SessionMessageSubscriptionResponse>,
  ): Promise<SessionMessageSubscriptionResponse> {
    // Replays describe a moment in time. Share concurrent requests, but let
    // each later viewer retrieve the Gateway's current pending set.
    const tracked = request.finally(() => {
      if (entry.approvalRequest === tracked) {
        entry.approvalRequest = null;
      }
    });
    entry.approvalRequest = tracked;
    return tracked;
  }

  #requestSubscribe(
    entry: SessionMessageSubscriptionEntry,
    includeApprovals: boolean,
    mode?: "full" | "narration",
  ): Promise<SessionMessageSubscriptionResponse> {
    const send = () => this.#sendSubscribe(entry, includeApprovals, mode);
    // Approval replay and stream-mode changes replace the same wire observer.
    // Serializing them prevents a slow narration replay from undoing a full upgrade.
    const request = entry.wireRequest ? entry.wireRequest.then(send, send) : send();
    const tracked = request.finally(() => {
      if (entry.wireRequest === tracked) {
        entry.wireRequest = null;
      }
    });
    entry.wireRequest = tracked;
    return tracked;
  }

  #requestMessages(
    entry: SessionMessageSubscriptionEntry,
    subscription?: { mode?: "narration"; includeApprovals: boolean },
  ) {
    const agentId = entry.key === "global" ? (entry.ownerAgentId ?? entry.agentId) : entry.agentId;
    return this.#client.request(
      subscription ? "sessions.messages.subscribe" : "sessions.messages.unsubscribe",
      {
        subscriptionId: entry.subscriptionId,
        key: entry.key,
        ...(agentId ? { agentId } : {}),
        ...(subscription?.mode ? { mode: subscription.mode } : {}),
        ...(subscription?.includeApprovals ? { includeApprovals: true } : {}),
      },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
  }

  async #sendSubscribe(
    entry: SessionMessageSubscriptionEntry,
    requestedApprovals: boolean,
    requestedMode?: "full" | "narration",
  ): Promise<SessionMessageSubscriptionResponse> {
    if (this.#retired) {
      throw new Error("Session message subscription belongs to a replaced Gateway connection");
    }
    // A preceding queued request may already have upgraded every full owner.
    if (requestedMode === "full" && entry.mode !== "narration") {
      return { key: entry.key };
    }
    const includeApprovals =
      requestedApprovals || (requestedMode !== undefined && entry.includeApprovals);
    const mode =
      requestedMode === "narration" ||
      (requestedMode !== "full" &&
        entry.pendingFullOwners === 0 &&
        [...entry.handles].every((handle) => handle.mode === "narration"))
        ? "narration"
        : undefined;
    const result = await this.#requestMessages(entry, { mode, includeApprovals }).catch(
      async (error: unknown) => {
        if (
          !(error instanceof GatewayProtocolRequestTimeoutError) ||
          !error.requestSent ||
          this.#retired
        ) {
          throw error;
        }
        try {
          // A sent request can commit before its acknowledgment. Restore only
          // capabilities still owned by acquired leases, including older approval panes.
          const retainedApprovals = [...entry.handles].some((handle) => handle.includeApprovals);
          const retainedMode =
            entry.handles.size > 0 &&
            [...entry.handles].every((handle) => handle.mode === "narration")
              ? "narration"
              : undefined;
          await this.#requestMessages(
            entry,
            entry.handles.size > 0
              ? { mode: retainedMode, includeApprovals: retainedApprovals }
              : undefined,
          );
          entry.mode = retainedMode;
          entry.includeApprovals = retainedApprovals;
        } catch (recoveryError) {
          if (!this.#retired) {
            const subscriptionRecoveryFailure = new AggregateError(
              [error, recoveryError],
              "session message subscription recovery failed",
              { cause: recoveryError },
            );
            throw subscriptionRecoveryFailure;
          }
        }
        throw error;
      },
    );
    const response = result && typeof result === "object" ? result : null;
    const responseKey = response && "key" in response ? response.key : undefined;
    entry.key =
      typeof responseKey === "string" && responseKey.trim() ? responseKey.trim() : entry.key;
    entry.canonicalSettled = true;
    const responseAgentId = response && "agentId" in response ? response.agentId : undefined;
    entry.ownerAgentId = normalizedAgentScope(
      (typeof responseAgentId === "string" ? responseAgentId : null) ??
        entry.ownerAgentId ??
        entry.scopeAgentId,
    );
    entry.mode = mode;
    entry.includeApprovals = includeApprovals;
    return {
      key: entry.key,
      ...(response && "approvalReplay" in response
        ? { approvalReplay: response.approvalReplay }
        : {}),
    };
  }

  #finishRelease(
    subscription: GatewaySessionMessageSubscription,
    owner: SessionMessageSubscriptionOwner,
    removeEntry = false,
  ): void {
    if (sessionMessageSubscriptionOwners.get(subscription) !== owner) {
      return;
    }
    sessionMessageSubscriptionOwners.delete(subscription);
    owner.entry.handles.delete(subscription);
    if (removeEntry) {
      this.#entries.delete(owner.entry);
    }
  }

  #areKeysEquivalent(left: string, right: string): boolean {
    return left === right || this.#keysEquivalent?.(left, right) === true;
  }

  #couldShareCanonicalIdentity(left: string, right: string): boolean {
    const leftBody = left.replace(/^agent:[^:]+:/i, "").toLowerCase();
    const rightBody = right.replace(/^agent:[^:]+:/i, "").toLowerCase();
    // Main/global routing can replace its body with a configured alias. Folding
    // opaque peer IDs only over-serializes; it never merges distinct observers.
    return (
      leftBody === rightBody ||
      leftBody === "main" ||
      rightBody === "main" ||
      leftBody === "global" ||
      rightBody === "global"
    );
  }
}

const sessionMessageSubscriptionOwners = new WeakMap<
  GatewaySessionMessageSubscription,
  SessionMessageSubscriptionOwner
>();

const sessionMessageSubscriptionCoordinators = new WeakMap<
  GatewaySessionMessageRequestClient,
  GatewaySessionMessageSubscriptionCoordinator
>();

export function getGatewaySessionMessageSubscriptionCoordinator(
  client: GatewaySessionMessageRequestClient,
  options: GatewaySessionMessageSubscriptionCoordinatorOptions = {},
): GatewaySessionMessageSubscriptionCoordinator {
  const existing = sessionMessageSubscriptionCoordinators.get(client);
  if (existing) {
    return existing.configure(options);
  }
  const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client, options);
  sessionMessageSubscriptionCoordinators.set(client, coordinator);
  return coordinator;
}

export function resetGatewaySessionMessageSubscriptionCoordinator(
  client: GatewaySessionMessageRequestClient,
): void {
  sessionMessageSubscriptionCoordinators.get(client)?.reset();
  sessionMessageSubscriptionCoordinators.delete(client);
}

export function releaseGatewaySessionMessageSubscription(
  subscription: GatewaySessionMessageSubscription,
): Promise<void> {
  return (
    sessionMessageSubscriptionOwners.get(subscription)?.coordinator.release(subscription) ??
    Promise.resolve()
  );
}
