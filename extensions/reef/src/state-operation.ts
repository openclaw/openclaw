import type {
  PluginStateOperationCommand,
  PluginStateOperationTransaction,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ReviewApproval, ReviewRequest } from "../protocol/pipeline.js";
import {
  parseReefIdentityBinding,
  REEF_REGISTRATION_IDENTITY_KEY,
  type ReefIdentityBinding,
} from "./registration-state.js";
import {
  parseReefKeys,
  parseReefReviewRecord,
  REEF_DURABLE_MIGRATION_KEY,
  REEF_KEYS_KEY,
  REEF_KEYS_MIGRATION_KEY,
  type ReefReviewRecord,
} from "./state-format.js";
import {
  assertReefIdentityMigrationComplete,
  completedReefReviewToEvict,
  generateReefKeys,
  reefReviewDecision,
} from "./state-policy.js";
import type { ReefKeys } from "./types.js";

export type ReefInboxCursorRecord = ReefIdentityBinding & { cursor: number };
export const REEF_INBOX_CURSOR_KEY = "current";
type ReefReviewDecision = "none" | "pending" | { approved: boolean };

export { ReefReviewCapacityError } from "./state-policy.js";

export type ReefStateOperations = {
  "identity.generate": { input: undefined; output: ReefKeys };
  "identity.load": { input: undefined; output: ReefKeys | undefined };
  "identity.admit": { input: undefined; output: undefined };
  "review.request": {
    input: { review: ReviewRequest; maxEntries: number };
    output: ReviewApproval | undefined;
  };
  "review.decide": {
    input: { digest: string; approved: boolean };
    output: ReviewRequest | undefined;
  };
  "review.lookup": { input: { digest: string }; output: ReefReviewDecision };
  "review.list": { input: undefined; output: ReviewRequest[] };
  "cursor.load": { input: ReefIdentityBinding; output: number };
  "cursor.advance": { input: ReefInboxCursorRecord; output: undefined };
};

export function requestReefReview(
  tx: PluginStateOperationTransaction,
  store: number,
  maxEntries: number,
  review: ReviewRequest,
): ReviewApproval | undefined {
  const key = review.approvalDigest;
  const current = parseReefReviewRecord(tx.lookup(store, key));
  if (current) {
    return current.approved === undefined
      ? undefined
      : { approved: current.approved, approvalDigest: key };
  }
  const evicted = completedReefReviewToEvict(tx.entries<ReefReviewRecord>(store), maxEntries);
  if (evicted !== undefined) {
    tx.delete(store, evicted);
  }
  tx.set(store, key, { review });
  return undefined;
}

function decideReefReview(
  tx: PluginStateOperationTransaction,
  store: number,
  digest: string,
  approved: boolean,
): ReviewRequest | undefined {
  const current = parseReefReviewRecord(tx.lookup(store, digest));
  if (!current) {
    return undefined;
  }
  tx.set(store, digest, { ...current, approved });
  return current.review;
}

export function lookupReefReviewDecision(
  tx: PluginStateOperationTransaction,
  store: number,
  digest: string,
): ReefReviewDecision {
  const current = parseReefReviewRecord(tx.lookup(store, digest));
  return reefReviewDecision(current);
}

export function requireReefInboxCursorRecord(
  value: unknown,
  binding: ReefIdentityBinding,
): ReefInboxCursorRecord {
  if (
    !isRecord(value) ||
    typeof value.handle !== "string" ||
    value.handle.length === 0 ||
    typeof value.relayUrl !== "string" ||
    value.relayUrl.length === 0 ||
    typeof value.cursor !== "number" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0
  ) {
    throw new Error("invalid Reef inbox cursor state");
  }
  if (value.handle !== binding.handle || value.relayUrl !== binding.relayUrl) {
    throw new Error("Reef inbox cursor belongs to a different identity");
  }
  return { handle: value.handle, relayUrl: value.relayUrl, cursor: value.cursor };
}

export function runReefStateOperation(
  command: PluginStateOperationCommand<ReefStateOperations>,
  tx: PluginStateOperationTransaction,
): ReefStateOperations[keyof ReefStateOperations]["output"] {
  switch (command.type) {
    case "identity.generate": {
      const [durable, migration, existing, registered] = tx.lookupMany([
        { store: 0, key: REEF_DURABLE_MIGRATION_KEY },
        { store: 1, key: REEF_KEYS_MIGRATION_KEY },
        { store: 2, key: REEF_KEYS_KEY },
        { store: 3, key: REEF_REGISTRATION_IDENTITY_KEY },
      ]);
      assertReefIdentityMigrationComplete(durable, migration);
      const binding = parseReefIdentityBinding(registered);
      if (binding) {
        throw new Error(
          `Reef identity @${binding.handle} on ${binding.relayUrl} has no canonical keys; restore the original keys before registration`,
        );
      }
      if (existing !== undefined) {
        throw new Error("Reef keys already exist in plugin state");
      }
      const keys = generateReefKeys();
      tx.set(2, REEF_KEYS_KEY, keys);
      return keys;
    }
    case "identity.load": {
      const [durable, migration, value] = tx.lookupMany([
        { store: 0, key: REEF_DURABLE_MIGRATION_KEY },
        { store: 1, key: REEF_KEYS_MIGRATION_KEY },
        { store: 2, key: REEF_KEYS_KEY },
      ]);
      assertReefIdentityMigrationComplete(durable, migration);
      return value ? parseReefKeys(value) : undefined;
    }
    case "identity.admit": {
      const [durable, migration] = tx.lookupMany([
        { store: 0, key: REEF_DURABLE_MIGRATION_KEY },
        { store: 1, key: REEF_KEYS_MIGRATION_KEY },
      ]);
      assertReefIdentityMigrationComplete(durable, migration);
      return undefined;
    }
    case "review.request":
      return requestReefReview(tx, 0, command.input.maxEntries, command.input.review);
    case "review.decide":
      return decideReefReview(tx, 0, command.input.digest, command.input.approved);
    case "review.lookup":
      return lookupReefReviewDecision(tx, 0, command.input.digest);
    case "review.list":
      return tx
        .entries<ReefReviewRecord>(0)
        .filter((entry) => entry.value.approved === undefined)
        .map((entry) => entry.value.review);
    case "cursor.load": {
      const value = tx.lookup(0, REEF_INBOX_CURSOR_KEY);
      return value === undefined ? 0 : requireReefInboxCursorRecord(value, command.input).cursor;
    }
    case "cursor.advance": {
      const { cursor } = command.input;
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("invalid Reef inbox cursor");
      }
      const value = tx.lookup(0, REEF_INBOX_CURSOR_KEY);
      const previous =
        value === undefined ? undefined : requireReefInboxCursorRecord(value, command.input);
      if (!previous || cursor > previous.cursor) {
        tx.set(0, REEF_INBOX_CURSOR_KEY, command.input);
      }
      return undefined;
    }
  }
  return command satisfies never;
}
