import type { ReplyToolAuthorityPreparation } from "../../../auto-reply/reply/reply-run-registry.contracts.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import {
  captureNativeSessionEntryCurrentRead,
  captureSessionEntryCurrentRead,
} from "../../../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
  SessionEntriesCurrentCheck,
} from "../../../config/sessions/session-entry-current.types.js";
import {
  withSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../../../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../../../config/sessions/session-store-target-inventory.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "../../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import {
  capturePreparedToolAuthorityReads,
  type PreparedToolAuthorityRead,
} from "../host-private-capabilities.js";

export type NativeSessionBindingRead = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

export type NativeSessionBindingLineage = {
  read: NativeSessionBindingRead;
  sessionId: string;
  previousSessionId?: string;
  createSupersededError: (sessionId: string) => Error;
};

/** A fresh lineage read owns custody only through the synchronous effect admission. */
export type NativeSessionBindingWithCurrent = <T>(consume: () => T) => Promise<T>;
type NativePreparedPolicy = ReplyToolAuthorityPreparation & {
  onRefused?: (error: unknown) => "discarded";
};
type CapturedNativePolicy = {
  preparation: NativePreparedPolicy;
  reads: PreparedToolAuthorityRead[];
};
export type NativeSessionBindingAuthority = {
  readonly lineage: readonly NativeSessionBindingLineage[];
  /** Cancellation and lifecycle only; durable authority is acquired through withCurrent. */
  assertCurrent: () => void;
  /** For shipped synchronous capabilities that cannot await worker admission. */
  assertLegacyCurrent: () => void;
  withCurrent: NativeSessionBindingWithCurrent;
  withPreparedCurrent?: <T>(
    consume: () => T,
    preparations: readonly NativePreparedPolicy[],
  ) => Promise<T>;
  prepareMutation: () => Promise<{
    assertCurrent: () => void;
    sessionEntryCurrent?: SessionEntriesCurrentCheck;
  }>;
};

export function readNativeSessionBindingEntries<T>(
  reads: readonly NativeSessionBindingRead[],
  consume: (
    entries: readonly (Pick<SessionEntry, "sessionId" | "previousSessionId"> | undefined)[],
  ) => T,
  policies: readonly CapturedNativePolicy[] = [],
): Promise<T> {
  const sameRead = (left: NativeSessionBindingRead, right: NativeSessionBindingRead) =>
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.storePath === right.storePath &&
    left.env === right.env;
  // Share row observations, not lineage assertions or their lifecycle guards.
  const unique = reads.filter(
    (read, index) => reads.findIndex((candidate) => sameRead(candidate, read)) === index,
  );
  // Pin process-owned incarnations before any durable read yields.
  const native = new Map(
    unique
      .filter((read) => isIncognitoSessionKey(read.sessionKey))
      .map((read) => [read, captureNativeSessionEntryCurrentRead(read)] as const),
  );
  const durable = unique.filter((read) => !native.has(read));
  const inputs = durable.map((read) => ({
    ...read,
    snapshotFields: [],
    sessionKeys: [
      ...new Set([
        normalizeStoreSessionKey(read.sessionKey),
        ...collectSessionEntryLookupKeys(read.sessionKey),
      ]),
    ],
  }));
  return withSessionEntriesFromStoresInWorker(
    [
      ...inputs,
      ...policies.flatMap(({ reads: policyReads }) => policyReads.flatMap((read) => read.reads)),
    ],
    (prepared) => {
      const entries = unique.map((read) => {
        const index = durable.indexOf(read);
        return index < 0
          ? readNativeBindingLineage(native.get(read)!)
          : resolveSessionEntryCandidates({
              entries: prepared[index]!.result.entries,
              sessionKey: read.sessionKey,
              canonicalKeys: true,
            }).existing?.entry;
      });
      for (const read of prepared) {
        read.assertCurrent();
      }
      let offset = durable.length;
      const finalPolicyChecks: Array<() => void> = [];
      for (const { preparation, reads: policyReads } of policies) {
        const start = offset;
        offset += policyReads.reduce((count, read) => count + read.reads.length, 0);
        const assertPolicyCurrent = () => {
          let currentOffset = start;
          preparation.assertCurrent();
          for (const read of policyReads) {
            read.assertPrepared(prepared.slice(currentOffset, currentOffset + read.reads.length));
            currentOffset += read.reads.length;
          }
          if (!policyReads.length) {
            preparation.compatAssertCurrent();
          }
          preparation.assertCurrent();
        };
        try {
          if (policyReads.length) {
            assertPolicyCurrent();
          } else {
            preparation.assertCurrent();
          }
          finalPolicyChecks.push(assertPolicyCurrent);
        } catch (error) {
          if (preparation.onRefused?.(error) !== "discarded") {
            throw error;
          }
        }
      }
      // Refusal callbacks can revoke earlier survivors; legacy SQL runs only in this final pass.
      for (const assertPolicyCurrent of finalPolicyChecks) {
        assertPolicyCurrent();
      }
      for (const read of prepared) {
        read.assertCurrent();
      }
      return consume(
        reads.map((read) => entries[unique.findIndex((candidate) => sameRead(candidate, read))]),
      );
    },
    { ordered: true },
  );
}

export function createNativeSessionBindingAuthority(
  lineage: readonly NativeSessionBindingLineage[],
  assertCurrent: () => void,
): NativeSessionBindingAuthority {
  const assertEntry = (
    expected: NativeSessionBindingLineage,
    entry:
      | Pick<SessionEntry, "sessionId" | "previousSessionId">
      | SessionEntryCurrentFacts
      | undefined,
  ) => {
    if (
      !entry ||
      entry.sessionId !== expected.sessionId ||
      entry.previousSessionId !== expected.previousSessionId
    ) {
      throw expected.createSupersededError(expected.sessionId);
    }
  };
  return {
    lineage,
    assertCurrent,
    withCurrent: async (consume) => {
      assertCurrent();
      return readNativeSessionBindingEntries(
        lineage.map(({ read }) => read),
        (entries) => {
          assertCurrent();
          lineage.forEach((expected, index) => assertEntry(expected, entries[index]));
          return consume();
        },
      );
    },
    withPreparedCurrent: async (consume, preparations) => {
      assertCurrent();
      const sources = lineage.map(({ read }) => {
        if (isIncognitoSessionKey(read.sessionKey)) {
          return captureNativeSessionEntryCurrentRead(read).assertSourceCurrent;
        }
        const candidates = captureSessionStoreReadCandidates(read.storePath);
        const identities = captureSessionStoreCandidateIdentities(candidates);
        return () => {
          for (const candidate of candidates) {
            assertSessionStoreReadCandidate(candidate.path, candidates);
          }
          for (const [path, expected] of identities) {
            const current = readDatabasePathIdentitySync(path);
            if (
              current.key !== expected.key ||
              current.canonicalPath !== expected.canonicalPath ||
              current.birthtime !== expected.birthtime
            ) {
              throw new Error("Native session lineage source changed during tool preparation");
            }
          }
        };
      });
      const policies: CapturedNativePolicy[] = [];
      for (const preparation of preparations) {
        assertCurrent();
        try {
          policies.push({
            preparation,
            reads: await capturePreparedToolAuthorityReads(preparation),
          });
        } catch (error) {
          if (preparation.onRefused?.(error) !== "discarded") {
            throw error;
          }
        }
      }
      for (const check of sources) {
        check();
      }
      return readNativeSessionBindingEntries(
        lineage.map(({ read }) => read),
        (entries) => {
          assertCurrent();
          for (const check of sources) {
            check();
          }
          lineage.forEach((expected, index) => assertEntry(expected, entries[index]));
          return consume();
        },
        policies,
      );
    },
    prepareMutation: async () => {
      assertCurrent();
      const checks: SessionEntryCurrentCheck[] = [];
      const nativeChecks: Array<() => void> = [];
      const native = new Map(
        lineage
          .filter(({ read }) => isIncognitoSessionKey(read.sessionKey))
          .map(
            (expected) => [expected, captureNativeSessionEntryCurrentRead(expected.read)] as const,
          ),
      );
      for (const expected of lineage) {
        const nativeRead = native.get(expected);
        if (nativeRead) {
          const check = () => assertEntry(expected, readNativeBindingLineage(nativeRead));
          check();
          nativeChecks.push(check);
          continue;
        }
        await withSessionEntryReadOnlyInWorker(
          expected.read,
          assertCurrent,
          async (read, owner) => {
            if (!read.ok) {
              throw expected.createSupersededError(expected.sessionId);
            }
            assertEntry(expected, read.value);
            const captured = captureSessionEntryCurrentRead(expected.read, owner);
            if (captured.kind !== "file") {
              nativeChecks.push(() => assertEntry(expected, captured.readCurrent()));
              return;
            }
            checks.push({
              source: captured.source,
              assertCurrent: (facts) => {
                captured.assertSourceCurrent();
                assertEntry(expected, facts);
              },
            });
          },
        );
      }
      const assertMutationCurrent = () => {
        assertCurrent();
        for (const check of nativeChecks) {
          check();
        }
      };
      assertMutationCurrent();
      const restriction: SessionEntriesCurrentCheck | undefined = checks.length
        ? {
            sources: checks.map((check) => check.source),
            assertCurrent: (entries) => {
              checks.forEach((check, index) => check.assertCurrent(entries[index]));
            },
          }
        : undefined;
      return { assertCurrent: assertMutationCurrent, sessionEntryCurrent: restriction };
    },
    assertLegacyCurrent: () => {
      assertCurrent();
      for (const expected of lineage) {
        let entry: Pick<SessionEntry, "sessionId" | "previousSessionId"> | undefined;
        try {
          entry = isIncognitoSessionKey(expected.read.sessionKey)
            ? readNativeBindingLineage(captureNativeSessionEntryCurrentRead(expected.read))
            : loadSessionEntryReadOnly({
                ...expected.read,
                readConsistency: "latest",
                hydrateSkillPromptRefs: false,
              });
        } catch {
          throw expected.createSupersededError(expected.sessionId);
        }
        assertEntry(expected, entry);
      }
    },
  };
}

function readNativeBindingLineage(
  captured: ReturnType<typeof captureNativeSessionEntryCurrentRead>,
) {
  const entry = captured.readCurrent();
  if (!entry) {
    return undefined;
  }
  const previousSessionId = entry.previousSessionId;
  if (previousSessionId !== undefined && typeof previousSessionId !== "string") {
    throw new Error("Native session lineage has an invalid predecessor");
  }
  return { sessionId: entry.sessionId, previousSessionId };
}

/** Batch every owner into one retained read rather than nesting writer admissions. */
export function combineNativeSessionBindingAuthority(
  ...authorities: readonly (NativeSessionBindingAuthority | undefined)[]
): NativeSessionBindingAuthority {
  const present = [...new Set(authorities.filter((authority) => authority !== undefined))];
  if (present.length === 1) {
    return present[0]!;
  }
  return createNativeSessionBindingAuthority(
    present.flatMap(({ lineage }) => lineage),
    () => {
      for (const authority of present) {
        authority.assertCurrent();
      }
    },
  );
}
