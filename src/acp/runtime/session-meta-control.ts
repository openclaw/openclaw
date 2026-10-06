import {
  captureIncognitoSessionOperation,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import {
  matchesAcpSessionRuntimeLocator,
  resolveAcpSessionControlOwner,
} from "./session-control-owner.js";
import type {
  AcpSessionRuntimeLocator,
  AcpSessionControlConstraint,
} from "./session-meta-control.types.js";
import {
  assertAcpSessionMutationEntry,
  captureAcpSessionEntryBinding,
  type AcpSessionEntryExpectation,
} from "./session-meta-entry.kernel.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import { withAcpSessionEntryRead } from "./session-meta-read.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp, type AcpSessionStoreEntry } from "./session-meta-store.js";

type AcpSessionControlReadResult = {
  session: AcpSessionStoreEntry;
  entry: SessionEntry | undefined;
  constraint?: AcpSessionControlConstraint;
};

type AcpSessionControlReadParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  assertCurrent?: () => void;
};

/** Retain source custody; each effect gets a fresh metadata join, never a presence cache. */
export function prepareAcpSessionControlRead(params: AcpSessionControlReadParams) {
  const binding = captureIncognitoSessionOperation(params);
  if (!binding) {
    return prepareAcpSessionControlReadOwned(params);
  }
  return binding.actor.sessions.withSharedState(async () => {
    const released = createDeferredCore();
    void binding.actor.sessions.withSharedState(() => released.promise);
    try {
      const prepared = await withIncognitoSessionBinding(binding, () =>
        prepareAcpSessionControlReadOwned(params),
      );
      return {
        ...prepared,
        readCurrent: (cfg: OpenClawConfig) =>
          withIncognitoSessionBinding(binding, () => prepared.readCurrent(cfg)),
        release() {
          try {
            prepared.release();
          } finally {
            released.resolve();
          }
        },
      };
    } catch (error) {
      released.resolve();
      throw error;
    }
  });
}

async function prepareAcpSessionControlReadOwned(params: AcpSessionControlReadParams) {
  const captured = await captureAcpSessionReadContext(params);
  const target = resolveSessionStorePathForAcp({ ...params, ...captured });
  const databasePath = resolveOpenClawStateSqlitePath(captured.env);
  const incognito = isIncognitoSessionKey(target.storeSessionKey);
  const shared = captureOpenClawStateReadContext(databasePath);
  const { prepareSessionMutationFacts, SessionMutationFactsUnavailableError } =
    await import("../../gateway/session-sharing-preparation.js");
  captured.assertCurrent();
  shared.maintenanceScope?.assertAdmission();
  shared.admission.assertCurrent();
  const facts = await prepareSessionMutationFacts({
    cfg: captured.cfg,
    sessionKey: params.sessionKey,
    agentId: target.agentId,
    allowMissing: true,
  });
  let active = true;
  let source: AcpSessionControlConstraint["source"] | undefined;
  let initial: { entry: AcpSessionEntryExpectation; ownerKey: string | undefined } | undefined;
  const release = () => {
    active = false;
    facts.release();
  };
  const assertCurrent = (cfg: OpenClawConfig) => {
    if (!active) {
      throw new SessionMutationFactsUnavailableError();
    }
    captured.assertCurrent();
    shared.maintenanceScope?.assertAdmission();
    shared.admission.assertCurrent();
    const identity = readDatabasePathIdentitySync(databasePath);
    const expected = shared.admission.identity;
    if (
      identity.key !== expected.key ||
      identity.canonicalPath !== expected.canonicalPath ||
      identity.birthtime !== expected.birthtime
    ) {
      throw new SessionMutationFactsUnavailableError();
    }
    const current = facts.readCurrent(cfg);
    if (source) {
      const observed = readDatabasePathIdentitySync(source.path);
      if (
        current.sourcePath !== source.path ||
        current.sourceAgentId !== source.agentId ||
        observed.key !== source.identity.key ||
        observed.canonicalPath !== source.identity.canonicalPath ||
        observed.birthtime !== source.identity.birthtime
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
    }
    if (initial) {
      assertAcpSessionMutationEntry(
        current.target?.entry,
        initial.entry,
        undefined,
        "control read",
      );
      if (resolveAcpSessionControlOwner(current.target?.entry) !== initial.ownerKey) {
        throw new SessionMutationFactsUnavailableError();
      }
    }
    return current;
  };
  const readCurrent = async (cfg: OpenClawConfig): Promise<AcpSessionControlReadResult> => {
    assertCurrent(cfg);
    const read = await withAcpSessionEntryRead(
      {
        cfg,
        sessionKey: params.sessionKey,
        agentId: target.agentId,
        env: captured.env,
        databasePath,
        assertCurrent: () => {
          assertCurrent(cfg);
        },
      },
      (entry, owner) => {
        owner?.assertCurrent();
        if (source) {
          const scope = owner?.scope;
          if (owner?.kind !== "file" || !scope?.storePath) {
            throw new SessionMutationFactsUnavailableError();
          }
          const identity = readDatabasePathIdentitySync(scope.storePath);
          if (
            (scope.databaseAgentId ?? scope.agentId) !== source.agentId ||
            identity.key !== source.identity.key ||
            identity.canonicalPath !== source.identity.canonicalPath ||
            identity.birthtime !== source.identity.birthtime
          ) {
            throw new SessionMutationFactsUnavailableError();
          }
        }
        return entry;
      },
      { currentMetadata: true },
    );
    const current = assertCurrent(cfg);
    if (!read || read.storeReadFailed) {
      throw new SessionMutationFactsUnavailableError();
    }
    const entry = read.entry;
    assertAcpSessionMutationEntry(entry, current.target?.entry ?? null, undefined, "control read");
    if (
      resolveAcpSessionControlOwner(entry) !== resolveAcpSessionControlOwner(current.target?.entry)
    ) {
      throw new SessionMutationFactsUnavailableError();
    }
    const ownerKey = resolveAcpSessionControlOwner(entry);
    initial ??= {
      entry: entry ? captureAcpSessionEntryBinding(entry) : null,
      ownerKey,
    };
    let constraint: AcpSessionControlConstraint | undefined;
    if (!incognito && source) {
      constraint = {
        source,
        sharedSource: { path: databasePath, identity: { ...shared.admission.identity } },
        agentId: target.agentId,
        sessionKey: read.storeSessionKey,
        entry: entry ? captureAcpSessionEntryBinding(entry) : undefined,
        ownerKey,
        read: {
          keys: [buildAcpDatabaseSessionKey(read.storeSessionKey, target.agentId)],
        },
      };
    }
    return { session: read, entry, constraint };
  };
  try {
    const prepared = facts.readCurrent(params.cfg);
    if (!incognito && prepared.sourcePath && prepared.sourceAgentId) {
      source = {
        agentId: prepared.sourceAgentId,
        path: prepared.sourcePath,
        identity: readDatabasePathIdentitySync(prepared.sourcePath),
      };
    }
    const initialRead = await readCurrent(params.cfg);
    return {
      initialRead,
      readCurrent,
      assertCurrent: (cfg: OpenClawConfig) => {
        assertCurrent(cfg);
      },
      // Incognito's retained native admission must still join the separate global ACP row.
      ...(incognito
        ? {
            assertNativeAcpCurrent(cfg: OpenClawConfig, runtimeLocator?: AcpSessionRuntimeLocator) {
              const current = assertCurrent(cfg);
              const acp = readAcpSessionMetaForEntry(
                {
                  cfg,
                  sessionKey: target.storeSessionKey,
                  agentId: target.agentId,
                  entry: current.target?.entry,
                  env: captured.env,
                  databasePath,
                },
                { current: true },
              );
              assertCurrent(cfg);
              if (
                !acp ||
                (runtimeLocator && !matchesAcpSessionRuntimeLocator(acp, runtimeLocator))
              ) {
                throw new SessionMutationFactsUnavailableError();
              }
            },
          }
        : {}),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
