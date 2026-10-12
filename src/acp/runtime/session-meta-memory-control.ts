import type { SessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import {
  matchesAcpSessionRuntimeLocator,
  resolveAcpSessionControlOwner,
} from "./session-control-owner.js";
import type {
  AcpSessionControlConstraint,
  AcpSessionRuntimeLocator,
} from "./session-meta-control.types.js";
import {
  assertAcpSessionMutationEntry,
  captureAcpSessionEntryBinding,
} from "./session-meta-entry.kernel.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import type { AcpSessionEntryReadInput, AcpSessionStoreEntry } from "./session-meta-read.types.js";
import { readAcpSessionMetaForEntries } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";

type AcpFact = Extract<SessionRowFacts, { kind: "acp" }>;

/** Keep the shared owner's receipts only for this control operation, never in actor state. */
export async function prepareMemoryAcpSessionControlRead(
  params: AcpSessionEntryReadInput,
  binding: SessionActorStorageBinding,
) {
  const captured = await captureAcpSessionReadContext(params);
  const target = resolveSessionStorePathForAcp({ ...params, ...captured });
  const shared = captureOpenClawStateReadContext(
    captured.databasePath ?? resolveOpenClawStateSqlitePath(captured.env),
  );
  let active = true;
  let initialEntry: ReturnType<typeof captureAcpSessionEntryBinding> | null | undefined;
  let initialOwner: string | undefined;
  let metadata: { acp: SessionAcpMeta | undefined } | undefined;
  let selectedEntry: SessionEntry | undefined;
  let reading = false;
  let published: AcpFact | null | undefined;
  const install = (fact: AcpFact | null, entry: SessionEntry | undefined) => {
    metadata =
      fact &&
      fact.sessionId === entry?.sessionId &&
      fact.lifecycleRevision === (entry?.lifecycleRevision ?? null) &&
      fact.sessionStartedAt === entry?.sessionStartedAt
        ? { acp: fact.acp ? structuredClone(fact.acp) : undefined }
        : undefined;
  };
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if ("all" in change) {
      if (typeof change.scope === "string" && change.scope !== "acp" && change.scope !== "stores") {
        return;
      }
      metadata = undefined;
      if (reading) {
        published = null;
      }
      return;
    }
    if (
      change.scope !== "acp" ||
      change.sessionKey !== target.storeSessionKey ||
      (change.agentId && change.agentId !== binding.agentId)
    ) {
      return;
    }
    const fact = change.facts?.kind === "acp" ? change.facts : null;
    if (reading) {
      published = fact;
    }
    if (!fact) {
      metadata = undefined;
    } else {
      install(fact, selectedEntry);
    }
  });
  const assertCurrent = (_cfg: OpenClawConfig) => {
    if (!active) {
      throw new Error("ACP control read was released");
    }
    params.assertCurrent?.();
    shared.maintenanceScope?.assertAdmission();
    shared.admission.assertCurrent();
    const entry = binding.actor.snapshot(binding.authority)?.entry;
    if (initialEntry !== undefined) {
      assertAcpSessionMutationEntry(entry, initialEntry, undefined, "control read");
      if (resolveAcpSessionControlOwner(entry) !== initialOwner) {
        throw new Error("Canonical ACP control owner changed");
      }
    }
    return entry;
  };
  const readCurrent = async (
    cfg: OpenClawConfig,
  ): Promise<{
    session: AcpSessionStoreEntry;
    entry: SessionEntry | undefined;
    constraint?: AcpSessionControlConstraint;
  }> => {
    const entry = assertCurrent(cfg);
    selectedEntry = entry && structuredClone(entry);
    reading = true;
    published = undefined;
    try {
      const [acp] = await readAcpSessionMetaForEntries(
        {
          ...captured,
          cfg,
          entries: [{ agentId: binding.agentId, sessionKey: target.storeSessionKey, entry }],
        },
        { current: true },
      );
      metadata = { acp: acp ?? undefined };
      if (published !== undefined) {
        install(published, entry);
      }
      if (!metadata) {
        throw new Error("ACP metadata changed without a committed result; retry control");
      }
      initialEntry ??= entry ? captureAcpSessionEntryBinding(entry) : null;
      initialOwner = resolveAcpSessionControlOwner(entry);
      return {
        session: {
          ...target,
          storePath: binding.path,
          sessionKey: params.sessionKey.trim(),
          entry,
          acp: metadata.acp && structuredClone(metadata.acp),
        },
        entry,
      };
    } finally {
      reading = false;
    }
  };
  const release = () => {
    active = false;
    unsubscribe();
  };
  try {
    const initialRead = await readCurrent(captured.cfg);
    return {
      initialRead,
      readCurrent,
      assertCurrent,
      // Existing control callers use this hook immediately before their effect.
      assertNativeAcpCurrent(cfg: OpenClawConfig, runtimeLocator?: AcpSessionRuntimeLocator) {
        assertCurrent(cfg);
        if (
          !metadata?.acp ||
          (runtimeLocator && !matchesAcpSessionRuntimeLocator(metadata.acp, runtimeLocator))
        ) {
          throw new Error("Canonical ACP runtime locator changed before control");
        }
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
