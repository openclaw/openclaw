import fs from "node:fs";
import path from "node:path";

export type PendingActionStatus = "pending" | "approved" | "denied" | "expired";

export type PendingAction = {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  status: PendingActionStatus;
  sessionId?: string;
  authorizedUserId?: string;
};

export class PendingActionStore {
  private actions = new Map<string, PendingAction>();
  private filePath?: string;
  private persistQueue: Array<() => void> = [];
  private isPersisting = false;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(content) as { actions: PendingAction[] };
        for (const action of data.actions) {
          this.actions.set(action.id, action);
        }
      } catch {
        // File corrupt or unreadable — start fresh
      }
    }
  }

  private persist(): void {
    if (!this.filePath) return;

    this.persistQueue.push(() => {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = { actions: Array.from(this.actions.values()) };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    });

    this.flushPersistQueue();
  }

  private flushPersistQueue(): void {
    if (this.persistQueue.length > 0 && !this.isPersisting) {
      this.isPersisting = true;
      const next = this.persistQueue.shift()!;
      try {
        next();
      } finally {
        this.isPersisting = false;
        if (this.persistQueue.length > 0) {
          this.flushPersistQueue();
        }
      }
    }
  }

  add(action: PendingAction): void {
    this.actions.set(action.id, action);
    this.persist();
  }

  get(id: string): PendingAction | undefined {
    return this.actions.get(id);
  }

  remove(id: string): void {
    this.actions.delete(id);
    this.persist();
  }

  getExpired(): PendingAction[] {
    const now = Date.now();
    const expired: PendingAction[] = [];
    for (const action of this.actions.values()) {
      if (action.expiresAt < now) {
        expired.push(action);
      }
    }
    return expired;
  }

  listByTool(tool: string): PendingAction[] {
    return Array.from(this.actions.values()).filter((a) => a.tool === tool);
  }

  clear(): void {
    this.actions.clear();
    this.persist();
  }

  getAll(): PendingAction[] {
    return Array.from(this.actions.values());
  }
}
