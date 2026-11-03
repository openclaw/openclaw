import type { AutofillApprovalSnapshot } from "./autofill-contract.js";
import type { AutofillClock } from "./autofill-poll.js";
import type { AutofillRequest } from "./autofill-service.js";

/** Ephemeral private-link custody, never persisted with the durable request reference. */
export class AutofillApprovalLinks {
  private readonly links = new Map<string, { appLink: string; expiresAt: number }>();

  constructor(private readonly clock: Pick<AutofillClock, "now">) {}

  /** Keep only a bounded, ten-minute native-app reference; reload intentionally loses it. */
  remember(id: string, appLink: string): void {
    this.prune();
    if (this.links.size >= 64) {
      this.links.delete(this.links.keys().next().value!);
    }
    this.links.set(id, { appLink, expiresAt: this.clock.now() + 600_000 });
  }

  /** Retire a link when its connection, checker, or request is no longer usable. */
  forget(id: string): void {
    this.links.delete(id);
  }

  /** Release private references on service retirement. */
  clear(): void {
    this.links.clear();
  }

  /** The service timer sweeps even when nobody mounts old transcript views. */
  prune(): void {
    for (const [id, link] of this.links) {
      if (link.expiresAt <= this.clock.now()) {
        this.links.delete(id);
      }
    }
  }

  /** Project a view only after the service has authorized its request and live connection. */
  snapshot(record: AutofillRequest): AutofillApprovalSnapshot {
    this.prune();
    const id = record.request.id;
    const metadata = {
      goal: record.request.goal,
      entries: record.request.entries.map((entry) => ({
        domain: new URL(entry.parameters.website).hostname,
        reason: entry.reason,
        granted: record.status.resolved.some((grant) => grant.entryId === entry.id),
      })),
    };
    if (record.status.state !== "pending") {
      this.forget(id);
      return { ...metadata, state: record.status.state };
    }
    const link = this.links.get(id);
    if (!link) {
      return { ...metadata, state: "unavailable" };
    }
    const deadline = record.openedAt === undefined ? undefined : record.openedAt + 120_000;
    if (deadline !== undefined && deadline <= this.clock.now()) {
      return { ...metadata, state: "expired" };
    }
    return {
      ...metadata,
      state: record.status.state,
      appLink: link.appLink,
      expiresAt: link.expiresAt,
      ...(deadline !== undefined ? { openedAt: record.openedAt, deadline } : {}),
    };
  }
}
