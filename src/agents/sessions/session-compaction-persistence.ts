import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { CompactionEntry } from "./session-manager-types.js";

/** Prepared data only; the original runtime owner still authorizes the commit. */
export type PreparedCompactionAppend = {
  scope: SessionTranscriptRuntimeTarget &
    Pick<
      SessionTranscriptWriteScope,
      "env" | "expectedLifecycleRevision" | "expectedWriterRunId" | "expectedOwner"
    >;
  event: CompactionEntry;
  appendIntent?: "active-branch";
  expectedMutationAt?: number | null;
  initializeEntry?: boolean;
};

export type CommittedCompactionAppend = {
  result: CompactionEntry;
  before: SessionTranscriptContextVersion;
  after: SessionTranscriptContextVersion;
};

export type CompactionAppendPersistence = (
  prepared: PreparedCompactionAppend,
) => CommittedCompactionAppend;

export type CompactionAppendPersistenceAsync = (
  prepared: PreparedCompactionAppend,
) => Promise<CommittedCompactionAppend>;

type CompactionInvocation<Persist = CompactionAppendPersistence> = {
  manager: object;
  persist: Persist;
  active: boolean;
};

// Native core and separately loaded SDK graphs must observe the same invocation.
const invocation = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCompactionPersistence"),
  () => new AsyncLocalStorage<CompactionInvocation>(),
);

/** Bind host accounting only to this exact manager's synchronous compaction invocation. */
export function withSessionCompactionPersistence(
  manager: object,
  persist: CompactionAppendPersistence | undefined,
  append: () => string,
): string {
  if (!persist) {
    return append();
  }
  const current = { manager, persist, active: true };
  try {
    return invocation.run(current, append);
  } finally {
    current.active = false;
  }
}

export function getSessionCompactionPersistence(
  manager: object,
): CompactionAppendPersistence | undefined {
  const current = invocation.getStore();
  return current?.active && current.manager === manager ? current.persist : undefined;
}

const asyncInvocation = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCompactionPersistenceAsync"),
  () => new AsyncLocalStorage<CompactionInvocation<CompactionAppendPersistenceAsync>>(),
);

/** Retain accounting authority until this exact manager's awaited append settles. */
export async function withSessionCompactionPersistenceAsync(
  manager: object,
  persist: CompactionAppendPersistenceAsync | undefined,
  append: () => Promise<string>,
): Promise<string> {
  if (!persist) {
    return await append();
  }
  const current = { manager, persist, active: true };
  try {
    return await asyncInvocation.run(current, append);
  } finally {
    current.active = false;
  }
}

export function getSessionCompactionPersistenceAsync(
  manager: object,
): CompactionAppendPersistenceAsync | undefined {
  const current = asyncInvocation.getStore();
  return current?.active && current.manager === manager ? current.persist : undefined;
}
