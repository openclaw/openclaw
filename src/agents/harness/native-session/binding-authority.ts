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
import type {
  PreparedSessionSourceAuthority,
  SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "../../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";

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
export type NativeSessionBindingAuthority = {
  readonly lineage: readonly NativeSessionBindingLineage[];
  /** Cancellation and lifecycle only; durable authority is acquired through withCurrent. */
  assertCurrent: () => void;
  /** For shipped synchronous capabilities that cannot await worker admission. */
  assertLegacyCurrent: SessionSourceAssertion;
  withCurrent: NativeSessionBindingWithCurrent;
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
  return withSessionEntriesFromStoresInWorker(
    durable.map((read) => ({
      ...read,
      snapshotFields: [],
      sessionKeys: [
        ...new Set([
          normalizeStoreSessionKey(read.sessionKey),
          ...collectSessionEntryLookupKeys(read.sessionKey),
        ]),
      ],
    })),
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
  const authority = {
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
    prepareMutation: async () => {
      assertCurrent();
      const checks: SessionEntryCurrentCheck[] = [];
      const sourceChecks: PreparedSessionSourceAuthority["checks"] = [];
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
            sourceChecks.push({
              predicate: {
                source: captured.source,
                sessionKey: captured.source.sessionKey,
                fields: ["sessionId", "previousSessionId"],
                expected: {
                  sessionId: expected.sessionId,
                  previousSessionId: expected.previousSessionId,
                },
              },
              refuse: () => {
                throw expected.createSupersededError(expected.sessionId);
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
      return {
        assertCurrent: assertMutationCurrent,
        sessionEntryCurrent: restriction,
        sessionSource: {
          assertCurrent: assertMutationCurrent,
          checks: sourceChecks,
          nativeSource: nativeChecks.length > 0,
        },
      };
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
  } satisfies NativeSessionBindingAuthority;
  Object.assign(authority.assertLegacyCurrent, {
    prepareSessionSource: async () => (await authority.prepareMutation()).sessionSource,
  });
  return authority;
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
