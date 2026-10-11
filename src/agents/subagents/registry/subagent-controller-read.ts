import path from "node:path";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "../../../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionSharingEntry } from "../../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../../config/sessions/session-actor-storage-binding.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { withSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { captureSessionStoreReadCandidates } from "../../../config/sessions/session-store-target-inventory.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { SessionMutationFactsUnavailableError } from "../../../gateway/session-sharing-preparation.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
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
  readCurrent: () => SessionSharingEntry | undefined;
  release: () => void;
};

function captureControllerMemoryFacts(
  agentId: string,
  request: ReadRequest,
  callerSessionKey: string | undefined,
  assertCurrent: () => void,
): Facts | undefined {
  const privateRequest = isIncognitoSessionKey(request.key);
  const memory = captureSessionActorStorageOwner(
    {
      agentId,
      sessionKey: privateRequest
        ? request.key
        : request.kind === "id"
          ? callerSessionKey
          : request.key,
    },
    { assertCurrent, authorize() {} },
  );
  if (memory) {
    const readCurrent = () => {
      memory.binding?.actor.assertReadable();
      const entry =
        request.kind === "key"
          ? readCapturedSessionActorEntry(memory, request.key)
          : memory.owner
            ? memory.owner.readSessionById(request.key.trim(), memory.authority, {
                currentOnly: true,
              })?.entry
            : memory.binding?.agentId === memory.agentId
              ? memory.binding.actor.storage?.readCurrent(
                  {
                    type: "session.entry.readById",
                    input: {
                      sessionId: request.key.trim(),
                      currentOnly: true,
                      projection: "list",
                    },
                  },
                  memory.authority,
                )?.entry
              : undefined;
      return entry && projectSessionSharingEntry(entry);
    };
    if (privateRequest || readCurrent()) {
      return { sourcePath: memory.path, readCurrent, release() {} };
    }
  }
  return undefined;
}

async function prepareControllerFacts(
  cfg: OpenClawConfig,
  agentId: string,
  request: ReadRequest,
): Promise<Facts> {
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
  const store = (): SessionCapabilityLookup => ({
    authoritative: true,
    get(key) {
      const facts = keys.get(key);
      if (!facts) {
        throw new ControllerReadRequired({ kind: "key", key });
      }
      return facts.readCurrent();
    },
    getById(key) {
      const selected = ids.get(key);
      if (!selected) {
        throw new ControllerReadRequired({ kind: "id", key });
      }
      if (selected.invalidated) {
        throw new Error("Subagent controller session-id selection changed.");
      }
      const entry = selected.facts?.readCurrent();
      if (entry && entry.sessionId.trim() !== key.trim()) {
        throw new Error("Subagent controller session-id selection changed.");
      }
      return entry;
    },
  });
  const read = () => {
    assertCallerCurrent();
    return resolveSubagentController({
      cfg: params.config(),
      agentSessionKey: initial.callerSessionKey,
      agentId: initial.controllerAgentId,
      capabilityStore: store(),
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
    const memory = captureControllerMemoryFacts(
      agentId,
      request,
      initial.callerSessionKey,
      assertCallerCurrent,
    );
    if (memory) {
      if (request.kind === "key") {
        keys.set(request.key, memory);
      } else {
        ids.set(request.key, { facts: memory, invalidated: false });
      }
      return;
    }
    if (request.kind === "key") {
      const facts = await prepareControllerFacts(cfg, agentId, request);
      retain(facts);
      assertCallerCurrent();
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
    const facts = await prepareControllerFacts(cfg, agentId, request);
    retain(facts);
    assertCallerCurrent();
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
    // Cancellation checks the current controller policy immediately before its effect.
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
