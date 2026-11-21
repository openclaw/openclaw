import { createHash, randomBytes, randomUUID } from "node:crypto";
import { record, SimlockClient, SimlockError, string, type Invocation } from "./client.js";

export type Owner = { agentId: string; sessionKey: string; sessionId: string };
export type Platform = "ios" | "android";
export type UiAction = "open" | "snapshot" | "click" | "type" | "fill" | "scroll" | "screenshot";
export const MAX_TTL_MS = 300_000;
// Pinned Simlock front/allocate.ts bounds waiting to 330s; a requested pool window is at most 300s.
const UNCERTAIN_SETTLE_MS = 330_000 + MAX_TTL_MS;
const MAX_RENEWAL_LIFETIME_MS = 30 * 60_000;

type Scope = {
  leaseId: string;
  tenantId: string;
  runId: string;
  clientId: string;
  deviceKey: string;
  leaseProvider: "proxy";
  backend: string;
};
type Receipt = {
  handle: string;
  leaseId: string;
  session: string;
  runId: string;
  clientId: string;
  platform: Platform;
  createdAt: number;
  expiresAt?: number;
  scope?: Scope;
  poolLeaseId?: string;
  state: "uncertain" | "active" | "renewal-failed" | "expired" | "ended";
};

function ownerKey(owner: Owner): string {
  if (!owner.agentId || !owner.sessionKey || !owner.sessionId) {
    throw new SimlockError("OWNER", "Simlock requires an identified owner conversation.");
  }
  return createHash("sha256")
    .update(JSON.stringify([owner.agentId, owner.sessionKey, owner.sessionId]))
    .digest("hex");
}

function ttl(value: number): number {
  if (!Number.isInteger(value) || value < 5_000 || value > MAX_TTL_MS) {
    throw new SimlockError("TTL", "Request a TTL between 5000 and 300000 milliseconds.");
  }
  return value;
}

function deadline(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SimlockError("PROTOCOL", "Simlock returned an invalid lease deadline.");
  }
  return value;
}

/** Receipts prove which lease this plugin acquired; Simlock alone owns the pool and TTL. */
export class SimlockController {
  private readonly receipts = new Map<string, Receipt>();
  private readonly busy = new Set<string>();
  constructor(
    private readonly client: SimlockClient,
    private readonly now: () => number = Date.now,
  ) {}

  private async exclusive<T>(
    owner: Owner,
    invocation: Invocation,
    operation: (key: string) => Promise<T>,
  ): Promise<T> {
    invocation.signal?.throwIfAborted();
    invocation.assertCurrent();
    const key = ownerKey(owner);
    if (this.busy.has(key)) {
      throw new SimlockError("BUSY", "Another Simlock operation is running in this conversation.");
    }
    this.busy.add(key);
    try {
      return await operation(key);
    } finally {
      this.busy.delete(key);
    }
  }

  private owned(key: string, handle: string): Receipt {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.handle !== handle) {
      throw new SimlockError("OWNER", "This conversation does not own that lease handle.");
    }
    return receipt;
  }

  private view(receipt: Receipt) {
    return {
      lease: receipt.handle,
      platform: receipt.platform,
      state: receipt.state,
      ...(receipt.state === "uncertain"
        ? { reconcileAfter: new Date(receipt.createdAt + UNCERTAIN_SETTLE_MS).toISOString() }
        : {}),
      ...(receipt.expiresAt === undefined
        ? {}
        : { expiresAt: new Date(receipt.expiresAt).toISOString() }),
    };
  }

  private acceptScope(receipt: Receipt, data: Record<string, unknown>) {
    const lease = record(data.lease);
    const scope: Scope = {
      leaseId: string(lease.leaseId),
      tenantId: string(lease.tenantId),
      runId: string(lease.runId),
      clientId: string(lease.clientId),
      deviceKey: string(lease.deviceKey),
      leaseProvider: "proxy",
      backend: string(lease.backend),
    };
    if (
      scope.leaseId !== receipt.leaseId ||
      scope.runId !== receipt.runId ||
      scope.clientId !== receipt.clientId ||
      lease.leaseProvider !== "proxy" ||
      scope.backend !== receipt.platform + "-instance" ||
      scope.deviceKey.length > 128 ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(scope.tenantId) ||
      (receipt.scope &&
        (scope.tenantId !== receipt.scope.tenantId || scope.deviceKey !== receipt.scope.deviceKey))
    ) {
      throw new SimlockError(
        "SCOPE",
        "Simlock returned a different lease scope; no replacement was accepted.",
      );
    }
    receipt.scope = scope;
    receipt.expiresAt = deadline(lease.expiresAt);
    receipt.state = receipt.expiresAt <= this.now() ? "expired" : "active";
  }

  private async refresh(receipt: Receipt, invocation: Invocation) {
    const status = await this.client.status(invocation);
    if (!Array.isArray(status.leases)) {
      throw new SimlockError("STARTING", "Simlock is not ready to report lease status.");
    }
    // The gateway may prefix its pool lease ID. requesterId is our caller-chosen random ID.
    const matches = status.leases
      .map(record)
      .filter((lease) => lease.requesterId === receipt.leaseId);
    if (matches.length > 1) {
      throw new SimlockError("SCOPE", "Simlock reported an ambiguous lease scope.");
    }
    const lease = matches[0];
    if (!lease) {
      receipt.poolLeaseId = undefined;
      // An interrupted allocation can still be settling. Do not forget it or automatically reacquire.
      if (receipt.scope) {
        receipt.state = "ended";
      }
      return (
        Array.isArray(status.waiting) &&
        !status.waiting.map(record).some((request) => request.requesterId === receipt.leaseId)
      );
    }
    const poolId = string(lease.id);
    if (receipt.poolLeaseId && poolId !== receipt.poolLeaseId) {
      throw new SimlockError("SCOPE", "Simlock reported a different pool lease.");
    }
    receipt.poolLeaseId = poolId;
    const expiresAt = deadline(lease.ttlDeadline);
    receipt.expiresAt =
      receipt.expiresAt === undefined ? expiresAt : Math.min(receipt.expiresAt, expiresAt);
    if (
      expiresAt <= this.now() ||
      (receipt.expiresAt !== undefined && receipt.expiresAt <= this.now())
    ) {
      receipt.state = "expired";
    }
    return false;
  }

  async discover(owner: Owner, invocation: Invocation) {
    return this.exclusive(owner, invocation, async () => {
      const health = await this.client.health(invocation);
      const status = await this.client.status(invocation);
      if (!Array.isArray(status.devices)) {
        throw new SimlockError(
          "STARTING",
          "Simlock is starting; device inventory is not available yet.",
        );
      }
      const devices = status.devices
        .map(record)
        .filter((device) => device.physical === false)
        .map((device) => {
          const spec = record(device.spec);
          return {
            platform:
              spec.platform === "ios"
                ? "ios"
                : spec.platform === "android"
                  ? "android"
                  : "unsupported",
            available: device.state === "ready",
          };
        });
      // No server, tenant, device, lease, worker IDs or user-chosen device names leave discovery.
      return { compatible: true, ...health, devices };
    });
  }

  async acquire(owner: Owner, platform: Platform, ttlMs: number, invocation: Invocation) {
    return this.exclusive(owner, invocation, async (key) => {
      ttl(ttlMs);
      const previous = this.receipts.get(key);
      if (previous) {
        throw new SimlockError(
          "EXISTING_LEASE",
          "This conversation already has a lease receipt. Check status or explicitly release it before acquiring another device.",
        );
      }
      await this.client.health(invocation);
      const receipt: Receipt = {
        handle: randomUUID(),
        leaseId: randomBytes(16).toString("hex"),
        session: randomUUID(),
        runId: randomUUID(),
        clientId: randomUUID(),
        platform,
        createdAt: this.now(),
        state: "uncertain",
      };
      this.receipts.set(key, receipt);
      try {
        const data = await this.client.rpc(
          "allocate",
          {
            session: receipt.session,
            leaseId: receipt.leaseId,
            runId: receipt.runId,
            clientId: receipt.clientId,
            leaseProvider: "proxy",
            backend: platform + "-instance",
            platform,
            ttlMs,
          },
          invocation,
        );
        this.acceptScope(receipt, data);
        return this.view(receipt);
      } catch (error) {
        if (error instanceof SimlockError && error.noEffect) {
          this.receipts.delete(key);
          throw error;
        }
        // Keep the receipt, never retry allocation or wipe a possibly successful device implicitly.
        if (error instanceof SimlockError) {
          throw new SimlockError(
            error.code,
            error.message + " Use simlock_status without a handle to inspect the retained receipt.",
          );
        }
        throw error;
      }
    });
  }

  async status(owner: Owner, handle: string | undefined, invocation: Invocation) {
    return this.exclusive(owner, invocation, async (key) => {
      const receipt = handle === undefined ? this.receipts.get(key) : this.owned(key, handle);
      if (!receipt) {
        return { state: "none" };
      }
      await this.refresh(receipt, invocation);
      return this.view(receipt);
    });
  }

  async renew(owner: Owner, handle: string, ttlMs: number, invocation: Invocation) {
    return this.exclusive(owner, invocation, async (key) => {
      const receipt = this.owned(key, handle);
      ttl(ttlMs);
      await this.refresh(receipt, invocation);
      if (!receipt.scope || receipt.state === "expired" || receipt.state === "ended") {
        throw new SimlockError(
          "ENDED",
          "This lease cannot be renewed; no new device was acquired.",
        );
      }
      if (this.now() + ttlMs > receipt.createdAt + MAX_RENEWAL_LIFETIME_MS) {
        throw new SimlockError(
          "RENEWAL_LIMIT",
          "This lease reached the plugin's 30-minute renewal budget. Explicitly release it; no replacement is automatic.",
        );
      }
      try {
        this.acceptScope(
          receipt,
          await this.client.rpc(
            "heartbeat",
            { session: receipt.session, ...receipt.scope, ttlMs },
            invocation,
          ),
        );
        return this.view(receipt);
      } catch (error) {
        receipt.state = "renewal-failed";
        throw error;
      }
    });
  }

  async release(owner: Owner, handle: string, effect: string, invocation: Invocation) {
    return this.exclusive(owner, invocation, async (key) => {
      if (effect !== "release-and-wipe") {
        throw new SimlockError(
          "CONFIRM_RELEASE",
          "Release can wipe app data. Explicitly authorize release-and-wipe.",
        );
      }
      const receipt = this.owned(key, handle);
      const noPendingRequest = await this.refresh(receipt, invocation);
      if ((receipt.state === "ended" || receipt.state === "expired") && !receipt.poolLeaseId) {
        this.receipts.delete(key);
        return {
          released: false,
          state: receipt.state,
          effect: "Lease already ended; no reset was requested.",
        };
      }
      if (!receipt.poolLeaseId) {
        if (
          !receipt.scope &&
          noPendingRequest &&
          this.now() >= receipt.createdAt + UNCERTAIN_SETTLE_MS
        ) {
          invocation.assertCurrent();
          this.receipts.delete(key);
          return {
            released: false,
            state: "reconciled-unallocated",
            effect:
              "No live or pending lease remained after the bounded allocation windows; receipt retired without a reset.",
          };
        }
        throw new SimlockError(
          "UNCERTAIN",
          "Allocation outcome is still uncertain. Keep this receipt and check status; no replacement or wipe was requested.",
        );
      }
      await this.client.releasePool(receipt.poolLeaseId, invocation);
      this.receipts.delete(key);
      return {
        released: true,
        effect: "Lease released; Simlock may wipe and reclaim this device.",
      };
    });
  }

  async ui(owner: Owner, handle: string, action: UiAction, args: string[], invocation: Invocation) {
    return this.exclusive(owner, invocation, async (key) => {
      const receipt = this.owned(key, handle);
      validateUi(action, args);
      await this.refresh(receipt, invocation);
      if (!receipt.scope || receipt.state !== "active") {
        throw new SimlockError(
          "INACTIVE",
          "The owned lease is not active. Check status or renew; no device will be replaced or reset.",
        );
      }
      const scope = receipt.scope;
      const effectInvocation: Invocation = {
        ...invocation,
        assertCurrent: () => {
          invocation.assertCurrent();
          if (receipt.expiresAt === undefined || receipt.expiresAt <= this.now()) {
            throw new SimlockError(
              "EXPIRED",
              "Lease expired before the UI effect; no replacement was requested.",
            );
          }
        },
      };
      const data = await this.client.rpc(
        "command",
        {
          session: receipt.session,
          command: action,
          positionals: args,
          flags: action === "open" ? { platform: receipt.platform } : {},
          meta: {
            tenantId: scope.tenantId,
            runId: scope.runId,
            leaseId: scope.leaseId,
            clientId: scope.clientId,
            deviceKey: scope.deviceKey,
            leaseProvider: scope.leaseProvider,
            leaseBackend: scope.backend,
          },
        },
        effectInvocation,
      );
      if (action !== "snapshot" && action !== "screenshot") {
        return { ok: true, action, lease: receipt.handle };
      }
      if (action === "snapshot") {
        return {
          snapshot: sanitizeSnapshot(data, (value) =>
            this.client.redact(value, [
              scope.leaseId,
              scope.tenantId,
              scope.runId,
              scope.clientId,
              scope.deviceKey,
              scope.deviceKey.split(":").slice(2).join(":"),
              receipt.session,
            ]),
          ),
          lease: receipt.handle,
        };
      }
      if (!Array.isArray(data.artifacts)) {
        throw new SimlockError("PROTOCOL", "Simlock did not return screenshot artifact metadata.");
      }
      const artifact = data.artifacts
        .map(record)
        .find((item) => item.field === "path" && item.artifactType === "screenshot");
      if (!artifact) {
        throw new SimlockError("PROTOCOL", "Simlock did not return a screenshot artifact.");
      }
      return {
        image: await this.client.screenshot(
          string(artifact.artifactId),
          receipt.leaseId,
          effectInvocation,
        ),
        lease: receipt.handle,
      };
    });
  }
}

export function validateUi(action: UiAction, args: string[]) {
  const ref = /^@e[0-9]+$/;
  const text = (value: string | undefined) => typeof value === "string" && value.length <= 4000;
  const valid =
    action === "open"
      ? args.length <= 1 &&
        (args.length === 0 || /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(args[0] ?? ""))
      : action === "snapshot" || action === "screenshot"
        ? args.length === 0
        : action === "click"
          ? (args.length === 1 && ref.test(args[0] ?? "")) ||
            (args.length === 2 && args.every((value) => /^\d{1,5}$/.test(value)))
          : action === "type"
            ? args.length === 1 && text(args[0])
            : action === "fill"
              ? args.length === 2 && ref.test(args[0] ?? "") && text(args[1])
              : action === "scroll"
                ? args.length === 1 && ["up", "down", "left", "right"].includes(args[0] ?? "")
                : false;
  if (!valid) {
    throw new SimlockError(
      "UI_ARGUMENTS",
      "Use the documented UI action and arguments; arbitrary commands, flags, paths, and reset operations are not supported.",
    );
  }
}

function sanitizeSnapshot(
  data: Record<string, unknown>,
  redact: (value: string) => string,
): unknown {
  if (!Array.isArray(data.nodes)) {
    throw new SimlockError("PROTOCOL", "Simlock did not return accessibility nodes.");
  }
  const textFields = [
    "ref",
    "type",
    "role",
    "subrole",
    "kind",
    "label",
    "value",
    "contentDescription",
    "identifier",
    "placeholder",
  ];
  const numericFields = ["index", "parentIndex", "depth", "selectionStart", "selectionEnd"];
  const booleanFields = [
    "enabled",
    "focused",
    "selected",
    "checked",
    "checkable",
    "clickable",
    "editable",
    "visible",
    "hidden",
    "scrollable",
  ];
  const nodes = data.nodes.slice(0, 1000).map((value) => {
    const node = record(value);
    if (!Number.isInteger(node.index)) {
      throw new SimlockError("PROTOCOL", "Simlock returned an invalid accessibility node.");
    }
    const result: Record<string, unknown> = {};
    for (const key of textFields) {
      if (typeof node[key] === "string") {
        result[key] = redact(node[key]);
      }
    }
    for (const key of numericFields) {
      if (typeof node[key] === "number" && Number.isFinite(node[key])) {
        result[key] = node[key];
      }
    }
    for (const key of booleanFields) {
      if (typeof node[key] === "boolean") {
        result[key] = node[key];
      }
    }
    if (node.rect !== undefined) {
      const rect = record(node.rect);
      if (
        ["x", "y", "width", "height"].every(
          (key) => typeof rect[key] === "number" && Number.isFinite(rect[key]),
        )
      ) {
        result.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    if (Array.isArray(node.actions)) {
      result.actions = node.actions
        .filter((item): item is string => typeof item === "string")
        .map(redact);
    }
    return result;
  });
  // App accessibility data is allowed; process, app provenance, paths, artifacts and routing envelopes are not.
  return { nodes, truncated: data.truncated === true || data.nodes.length > nodes.length };
}
