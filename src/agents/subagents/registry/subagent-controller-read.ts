import path from "node:path";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "../../../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionSharingEntry } from "../../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { withSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { IncognitoSessionFacts } from "../../../config/sessions/session-incognito-contract.js";
import { captureSessionStoreReadCandidates } from "../../../config/sessions/session-store-target-inventory.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "../../../gateway/session-sharing-preparation.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import type { IncognitoAgentDatabaseExecution } from "../../../state/openclaw-agent-execution-incognito.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import type { SessionCapabilityLookup } from "../spawn/subagent-session-store.js";
import {
  resolveSubagentController,
  resolveSubagentControllerIdentity,
} from "./subagent-control-scope.js";

type ReadRequest = { kind: "key" | "id"; key: string };
type Facts = {
  sourcePath?: string;
  databaseIdentity?: string;
  readCurrent: (
    config: OpenClawConfig,
    transactionFacts?: readonly IncognitoSessionFacts[],
  ) => SessionSharingEntry | undefined;
  release: () => void;
};

async function prepareControllerFacts(
  cfg: OpenClawConfig,
  agentId: string,
  request: ReadRequest,
  actor: IncognitoAgentDatabaseExecution | undefined,
  assertCurrent: () => void,
): Promise<Facts> {
  if (request.kind === "key" && isIncognitoSessionKey(request.key)) {
    if (actor) {
      if (actor.agentId !== agentId) {
        throw new SessionMutationFactsUnavailableError();
      }
      const { entry, claim } = await actor.sessions.read(
        { assertCurrent },
        { sessionKey: request.key },
      );
      return {
        sourcePath: actor.path,
        readCurrent(_current, transactionFacts) {
          actor.assertCurrent();
          const local = transactionFacts?.find((facts) => facts.sessionKey === request.key);
          if (local) {
            if (
              local.identity.handle !== claim.identity.handle ||
              local.identity.incarnation !== claim.identity.incarnation ||
              local.sharing?.entry?.sessionId !== entry?.sessionId ||
              local.sharing?.entry?.lifecycleRevision !== entry?.lifecycleRevision
            ) {
              throw new SessionMutationFactsUnavailableError();
            }
            // A grant's target is pending in the host projection; only its tx-local facts apply.
            return local.sharing?.entry;
          }
          claim.assertCurrent();
          return actor.sessions.readSharing(request.key)?.entry;
        },
        // The caller owns the actor borrow across all controller preparation and use.
        release() {},
      };
    }
    // Production keeps the process-held owner until the complete incognito cutover.
    const facts = await prepareSessionMutationFacts({
      cfg,
      agentId,
      sessionKey: request.key,
      allowMissing: true,
    });
    return {
      sourcePath: facts.storageTarget.storePath,
      readCurrent: (current) => facts.readCurrent(current).target?.entry,
      release: facts.release,
    };
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  let releasePrepared: (() => void) | undefined;
  try {
    return await withSessionEntriesFromStoreInWorker(
      {
        agentId,
        storePath,
        projection: "sharing",
        ...(request.kind === "key"
          ? { sessionKeys: [request.key] }
          : { selection: { kind: "session-id", sessionId: request.key.trim() } as const }),
      },
      async (read) => {
        const match = read.result.entries[0];
        const entry = match?.entry;
        const sessionKey = match?.sessionKey ?? request.key;
        const sharing = read.result.sharing;
        if (entry && !sharing) {
          throw new SessionMutationFactsUnavailableError();
        }
        const facts =
          sharing &&
          retainPreparedSessionSharingFacts({
            databaseIdentity: sharing.databaseIdentity,
            sessionKey,
            entry: entry ? projectSessionSharingEntry(entry) : undefined,
            membership: new Set(),
          });
        try {
          const generation = await prepareSessionGenerationFacts({
            storePath,
            agentId,
            sessionKey,
            sessionId: entry?.sessionId ?? null,
            lifecycleRevision: entry?.lifecycleRevision ?? null,
          });
          try {
            // Both leases overlap the original reader; closing/reopening cannot adopt a source.
            read.assertCurrent();
            generation.assertCurrent();
            releasePrepared = () => {
              facts?.release();
              generation.release();
            };
            return {
              sourcePath: sharing?.source.path,
              databaseIdentity: sharing?.databaseIdentity,
              readCurrent() {
                try {
                  generation.assertCurrent();
                  const value = facts?.readCurrent();
                  if (facts && !value) {
                    throw new SessionMutationFactsUnavailableError();
                  }
                  return value?.entry;
                } catch (error) {
                  throw error instanceof SessionMutationFactsUnavailableError
                    ? error
                    : new SessionMutationFactsUnavailableError({ cause: error });
                }
              },
              release: releasePrepared,
            };
          } catch (error) {
            generation.release();
            throw error;
          }
        } catch (error) {
          facts?.release();
          throw error;
        }
      },
    );
  } catch (error) {
    releasePrepared?.();
    throw error;
  }
}

class ControllerReadRequired extends Error {
  constructor(readonly request: ReadRequest) {
    super("Subagent controller facts require preparation.");
  }
}

/** Prepare only the lookups requested by the existing capability/depth policy. */
export function createSubagentControllerRead(params: {
  config: () => OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  assertCurrent: () => void;
  /** Prepared actor borrows owned by the caller; inactive until the runtime cutover. */
  incognito?: (agentId: string) => IncognitoAgentDatabaseExecution;
}) {
  // Keep prepared routing for this cancellation; control policy remains current.
  const cfg = params.config();
  const initial = resolveSubagentControllerIdentity({ ...params, cfg });
  const keys = new Map<string, Facts>();
  const ids = new Map<string, { facts?: Facts; invalidated: boolean }>();
  const releases: Array<() => void> = [];
  let pending: Promise<void> | undefined;
  let active = true;
  const retain = (facts: Facts) => {
    if (!active) {
      facts.release();
      throw new Error("Subagent controller read is no longer active.");
    }
    releases.push(facts.release);
  };
  const assertCallerCurrent = () => {
    if (!active) {
      throw new Error("Subagent controller read is no longer active.");
    }
    params.assertCurrent();
  };
  const assertCurrent = (transactionFacts?: readonly IncognitoSessionFacts[]) => {
    assertCallerCurrent();
    // These original source/identity leases cannot be replaced by a later lookup.
    for (const facts of keys.values()) {
      facts.readCurrent(cfg, transactionFacts);
    }
    for (const key of ids.keys()) {
      store(transactionFacts).getById(key);
    }
  };
  const store = (transactionFacts?: readonly IncognitoSessionFacts[]): SessionCapabilityLookup => ({
    authoritative: true,
    get(key) {
      const facts = keys.get(key);
      if (!facts) {
        throw new ControllerReadRequired({ kind: "key", key });
      }
      return facts.readCurrent(cfg, transactionFacts);
    },
    getById(key) {
      const selected = ids.get(key);
      if (!selected) {
        throw new ControllerReadRequired({ kind: "id", key });
      }
      if (selected.invalidated) {
        throw new Error("Subagent controller session-id selection changed.");
      }
      const entry = selected.facts?.readCurrent(cfg, transactionFacts);
      if (entry && entry.sessionId.trim() !== key.trim()) {
        throw new Error("Subagent controller session-id selection changed.");
      }
      return entry;
    },
  });
  const read = (transactionFacts?: readonly IncognitoSessionFacts[]) => {
    assertCurrent(transactionFacts);
    return resolveSubagentController({
      cfg: params.config(),
      agentSessionKey: initial.callerSessionKey,
      agentId: initial.controllerAgentId,
      capabilityStore: store(transactionFacts),
    });
  };
  const prepareRequest = async (request: ReadRequest) => {
    // Session IDs are opaque; only keys can select another agent's store.
    const agentId =
      (request.kind === "key" ? parseAgentSessionKey(request.key)?.agentId : undefined) ??
      initial.controllerAgentId ??
      resolveSessionAgentId({
        config: cfg,
        sessionKey: initial.callerSessionKey,
        agentId: params.agentId,
      });
    if (request.kind === "key") {
      const actor = isIncognitoSessionKey(request.key) ? params.incognito?.(agentId) : undefined;
      const facts = await prepareControllerFacts(cfg, agentId, request, actor, assertCallerCurrent);
      retain(facts);
      assertCurrent();
      keys.set(request.key, facts);
      return;
    }
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const selected: { invalidated: boolean; facts?: Facts } = { invalidated: false };
    const paths = new Set(
      captureSessionStoreReadCandidates(storePath).flatMap((candidate) => [
        path.resolve(candidate.path),
        path.resolve(candidate.physicalPath),
      ]),
    );
    const databaseIdentities = new Set(
      [...paths].map((pathname) => readDatabasePathIdentitySync(pathname).key),
    );
    const sessionId = request.key.trim();
    // A by-ID selection also depends on competing keys, including absent→present.
    // Existing entry publications invalidate that lookup; they never choose a successor.
    releases.push(
      onSessionIdentityMutation((change) => {
        if (
          typeof change.databaseIdentity === "string" &&
          databaseIdentities.has(`file:${change.databaseIdentity}`) &&
          [
            change.previous.sessionId,
            change.kind === "delete" ? undefined : change.current.sessionId,
          ].some((id) => id?.trim() === sessionId)
        ) {
          selected.invalidated = true;
        }
      }),
    );
    releases.push(
      sessionChanges.subscribeFacts((change) => {
        if ("all" in change) {
          if (
            typeof change.scope === "object" &&
            (!change.scope.agentId || change.scope.agentId === agentId) &&
            (!change.scope.storePath || paths.has(path.resolve(change.scope.storePath)))
          ) {
            selected.invalidated = true;
          } else if (
            typeof change.scope === "string" &&
            ["stores", "sessions"].includes(change.scope)
          ) {
            selected.invalidated = true;
          }
          return;
        }
        if (
          change.scope === "automation" ||
          (change.agentId && change.agentId !== agentId) ||
          (change.storePath && !paths.has(path.resolve(change.storePath)))
        ) {
          return;
        }
        // Confirmed worker publications update the retained facts before this event;
        // their identity owner reports key/ID changes separately. Unknown writes cannot.
        if (
          change.factsInvalidated &&
          !(change.scope === "session-entry" && isPreparedSessionSharingChange(change))
        ) {
          selected.invalidated = true;
        }
      }),
    );
    const facts = await prepareControllerFacts(
      cfg,
      agentId,
      request,
      undefined,
      assertCallerCurrent,
    );
    retain(facts);
    assertCurrent();
    if (facts.sourcePath) {
      paths.add(path.resolve(facts.sourcePath));
    }
    if (facts.databaseIdentity) {
      databaseIdentities.add(facts.databaseIdentity);
    }
    selected.facts = facts;
    if (selected.invalidated) {
      throw new Error("Subagent controller session-id selection changed.");
    }
    ids.set(request.key, selected);
  };
  const nextRequest = (): ReadRequest | undefined => {
    try {
      read();
      return undefined;
    } catch (error) {
      if (!(error instanceof ControllerReadRequired)) {
        throw error;
      }
      return error.request;
    }
  };
  const prepare = (): Promise<void> | undefined => {
    if (!pending) {
      let request = nextRequest();
      if (!request) {
        return undefined;
      }
      pending = (async () => {
        while (request) {
          await prepareRequest(request);
          request = nextRequest();
        }
      })().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
  return {
    // Actor grants use this source guard, then read their supplied transaction facts.
    assertCurrent: assertCallerCurrent,
    read,
    prepare,
    release() {
      active = false;
      for (const release of releases.splice(0).toReversed()) {
        release();
      }
    },
  };
}
