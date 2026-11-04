import { base64url } from "../protocol/encoding.js";
import { generateIdentity } from "../protocol/identity.js";
import type { ReefReviewRecord } from "./state-format.js";

export class ReefReviewCapacityError extends Error {
  constructor() {
    super("Reef pending review capacity is exhausted");
    this.name = "ReefReviewCapacityError";
  }
}

export function completedReefReviewToEvict(
  entries: Array<{ key: string; value: ReefReviewRecord; createdAt: number }>,
  maxEntries: number,
): string | undefined {
  if (entries.length < maxEntries) {
    return undefined;
  }
  const completed = entries
    .filter((entry) => entry.value.approved !== undefined)
    .toSorted((left, right) => left.createdAt - right.createdAt)[0];
  if (!completed) {
    throw new ReefReviewCapacityError();
  }
  return completed.key;
}

export function reefReviewDecision(
  current: ReefReviewRecord | undefined,
): "none" | "pending" | { approved: boolean } {
  return !current
    ? "none"
    : current.approved === undefined
      ? "pending"
      : { approved: current.approved };
}

export function assertReefIdentityMigrationComplete(durable: unknown, identity: unknown): void {
  if (durable || identity) {
    const kind = durable ? "durable state" : "identity";
    const files = durable ? "state" : "identity";
    throw new Error(
      `Reef ${kind} migration is incomplete; repair the legacy ${files} files and rerun openclaw doctor --fix`,
    );
  }
}

export function generateReefKeys() {
  const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { ...generateIdentity(), auditKey: random(), replayKey: random(), keyEpoch: 1 };
}
