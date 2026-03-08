export type BrowserWorkerCapability = "browse" | "snapshot" | "screenshot" | "interaction";

export type BrowserWorkerStatus = "online" | "degraded" | "offline";

export type BrowserWorkerDescriptor = {
  id: string;
  displayName: string;
  endpoint?: string;
  capabilities: BrowserWorkerCapability[];
  maxConcurrent: number;
  status: BrowserWorkerStatus;
  lastHeartbeatAt: number;
  metadata?: Record<string, string>;
};

export type BrowserWorkerLease = {
  taskId: string;
  workerId: string;
  leasedAt: number;
  leaseExpiresAt: number;
};

export class BrowserWorkerRegistry {
  private readonly workers = new Map<string, BrowserWorkerDescriptor>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  upsert(worker: Omit<BrowserWorkerDescriptor, "lastHeartbeatAt">): BrowserWorkerDescriptor {
    const next: BrowserWorkerDescriptor = {
      ...worker,
      lastHeartbeatAt: this.now(),
    };
    this.workers.set(next.id, next);
    return { ...next };
  }

  heartbeat(workerId: string): BrowserWorkerDescriptor | null {
    const current = this.workers.get(workerId);
    if (!current) {
      return null;
    }
    current.lastHeartbeatAt = this.now();
    current.status = "online";
    return { ...current };
  }

  setStatus(workerId: string, status: BrowserWorkerStatus): BrowserWorkerDescriptor | null {
    const current = this.workers.get(workerId);
    if (!current) {
      return null;
    }
    current.status = status;
    return { ...current };
  }

  get(workerId: string): BrowserWorkerDescriptor | null {
    const value = this.workers.get(workerId);
    return value ? { ...value } : null;
  }

  list(filter?: { status?: BrowserWorkerStatus }): BrowserWorkerDescriptor[] {
    let values = [...this.workers.values()];
    if (filter?.status) {
      values = values.filter((w) => w.status === filter.status);
    }
    return values
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((w) => ({ ...w }));
  }
}

