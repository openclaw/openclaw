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
  snapshot(record: AutofillRequest) {
    this.prune();
    const id = record.request.id;
    if (record.status.state !== "pending") {
      this.forget(id);
      return { state: record.status.state };
    }
    const link = this.links.get(id);
    if (!link) {
      return { state: "unavailable" };
    }
    if (record.openedAt !== undefined) {
      return {
        state: record.status.state,
        guidance: record.pollingEnded
          ? "Polling stopped after two minutes. Tell the agent when you have approved; it can check once more."
          : "Waiting for your decision. Refresh status after approving in 1Password.",
      };
    }
    return { state: record.status.state, appLink: link.appLink, expiresAt: link.expiresAt };
  }
}
