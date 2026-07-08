/** Window-scoped lease accounting for shared Codex Computer Use runtimes. */

export type CodexComputerUseLeaseAcquireResult =
  | {
      granted: true;
      lease: CodexComputerUseWindowLease;
    }
  | {
      granted: false;
      reason: "window_busy";
      activeLease: CodexComputerUseWindowLease;
      preemptionRequested: boolean;
    };

export type CodexComputerUseWindowLease = {
  id: string;
  windowId: string;
  holderId: string;
  acquiredAtMs: number;
  expiresAtMs: number;
  toolCallsActive: number;
  preemptionRequested: boolean;
};

type CodexComputerUseLeaseManagerOptions = {
  now?: () => number;
  idFactory?: () => string;
  defaultTimeoutMs?: number;
};

export type CodexComputerUseAcquireLeaseParams = {
  windowId: string;
  holderId: string;
  timeoutMs?: number;
  requestPreemption?: boolean;
};

const DEFAULT_COMPUTER_USE_WINDOW_LEASE_TIMEOUT_MS = 5 * 60_000;

/** Coordinates simultaneous Computer Use access per desktop window, not per app or globally. */
export class CodexComputerUseWindowLeaseManager {
  private readonly leasesByWindowId = new Map<string, CodexComputerUseWindowLease>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly defaultTimeoutMs: number;

  constructor(options: CodexComputerUseLeaseManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultLeaseId;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs && options.defaultTimeoutMs > 0
        ? options.defaultTimeoutMs
        : DEFAULT_COMPUTER_USE_WINDOW_LEASE_TIMEOUT_MS;
  }

  acquire(params: CodexComputerUseAcquireLeaseParams): CodexComputerUseLeaseAcquireResult {
    const windowId = params.windowId.trim();
    const holderId = params.holderId.trim();
    if (!windowId) {
      throw new Error("Computer Use lease windowId is required.");
    }
    if (!holderId) {
      throw new Error("Computer Use lease holderId is required.");
    }

    const now = this.now();
    const active = this.activeLeaseForWindow(windowId, now);
    if (active && active.holderId !== holderId) {
      if (params.requestPreemption) {
        active.preemptionRequested = true;
      }
      return {
        granted: false,
        reason: "window_busy",
        activeLease: { ...active },
        preemptionRequested: active.preemptionRequested,
      };
    }

    const timeoutMs =
      params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : this.defaultTimeoutMs;
    const lease: CodexComputerUseWindowLease = active
      ? {
          ...active,
          expiresAtMs: now + timeoutMs,
          preemptionRequested: false,
        }
      : {
          id: this.idFactory(),
          windowId,
          holderId,
          acquiredAtMs: now,
          expiresAtMs: now + timeoutMs,
          toolCallsActive: 0,
          preemptionRequested: false,
        };
    this.leasesByWindowId.set(windowId, lease);
    return { granted: true, lease: { ...lease } };
  }

  renew(leaseId: string, timeoutMs?: number): CodexComputerUseWindowLease | undefined {
    const now = this.now();
    for (const [windowId, lease] of this.leasesByWindowId) {
      if (lease.id !== leaseId) {
        continue;
      }
      if (lease.expiresAtMs <= now && lease.toolCallsActive === 0) {
        this.leasesByWindowId.delete(windowId);
        return undefined;
      }
      const nextTimeoutMs = timeoutMs && timeoutMs > 0 ? timeoutMs : this.defaultTimeoutMs;
      const renewed = {
        ...lease,
        expiresAtMs: now + nextTimeoutMs,
      };
      this.leasesByWindowId.set(windowId, renewed);
      return { ...renewed };
    }
    return undefined;
  }

  beginToolCall(leaseId: string): CodexComputerUseWindowLease | undefined {
    const lease = this.updateLeaseById(leaseId, (current) => ({
      ...current,
      toolCallsActive: current.toolCallsActive + 1,
    }));
    return lease ? this.renew(lease.id) : undefined;
  }

  endToolCall(leaseId: string): CodexComputerUseWindowLease | undefined {
    return this.updateLeaseById(leaseId, (current) => ({
      ...current,
      toolCallsActive: Math.max(0, current.toolCallsActive - 1),
    }));
  }

  release(leaseId: string): boolean {
    for (const [windowId, lease] of this.leasesByWindowId) {
      if (lease.id === leaseId) {
        this.leasesByWindowId.delete(windowId);
        return true;
      }
    }
    return false;
  }

  snapshot(): CodexComputerUseWindowLease[] {
    const now = this.now();
    for (const [windowId, lease] of this.leasesByWindowId) {
      if (lease.expiresAtMs <= now && lease.toolCallsActive === 0) {
        this.leasesByWindowId.delete(windowId);
      }
    }
    return [...this.leasesByWindowId.values()].map((lease) => ({ ...lease }));
  }

  private activeLeaseForWindow(
    windowId: string,
    now: number,
  ): CodexComputerUseWindowLease | undefined {
    const active = this.leasesByWindowId.get(windowId);
    if (!active) {
      return undefined;
    }
    if (active.expiresAtMs <= now && active.toolCallsActive === 0) {
      this.leasesByWindowId.delete(windowId);
      return undefined;
    }
    return active;
  }

  private updateLeaseById(
    leaseId: string,
    updater: (lease: CodexComputerUseWindowLease) => CodexComputerUseWindowLease,
  ): CodexComputerUseWindowLease | undefined {
    for (const [windowId, lease] of this.leasesByWindowId) {
      if (lease.id !== leaseId) {
        continue;
      }
      const next = updater(lease);
      this.leasesByWindowId.set(windowId, next);
      return { ...next };
    }
    return undefined;
  }
}

function defaultLeaseId(): string {
  return `computer-use-window-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
