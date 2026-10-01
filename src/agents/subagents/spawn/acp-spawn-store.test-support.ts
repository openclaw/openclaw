import type { SessionEntryReadScope } from "../../../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { resolveSessionStoreIdentity } from "../../../gateway/session-store-key.js";
import type { resolveGatewaySessionStoreTargetInWorker } from "../../../gateway/session-utils-store-worker.js";

type StoreScope = { agentId?: string; env?: NodeJS.ProcessEnv; storePath?: string };
type EntryScope = StoreScope & { sessionKey: string };
/** Native and worker reads share the ACP orchestration fixture's in-memory store. */
export function createAcpSpawnStoreMocks(mocks: {
  resolveStorePathMock: (path: undefined, options: StoreScope) => string;
  loadSessionStoreMock: (path: string) => Record<string, SessionEntry>;
  upsertSessionEntryMock: (scope: unknown, patch: SessionEntry) => Promise<SessionEntry>;
}) {
  const resolveStorePath = (scope: StoreScope): string =>
    scope.storePath ??
    mocks.resolveStorePathMock(undefined, { agentId: scope.agentId, env: scope.env });
  const loadEntry = (scope: EntryScope): SessionEntry | undefined =>
    mocks.loadSessionStoreMock(resolveStorePath(scope))[scope.sessionKey];
  const listEntries = (scope: StoreScope = {}) =>
    Object.entries(mocks.loadSessionStoreMock(resolveStorePath(scope))).map(
      ([sessionKey, entry]) => ({ sessionKey, entry }),
    );
  return {
    workerLookup: {
      resolveGatewaySessionStoreTargetInWorker: async (
        params: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0],
      ) => {
        params.assertActive?.();
        const { agentId, canonicalKey } = resolveSessionStoreIdentity({
          cfg: params.cfg,
          sessionKey: params.key,
          agentId: params.agentId,
        });
        const storePath = resolveStorePath({ agentId, env: params.env });
        return {
          agentId,
          canonicalKey,
          storePath,
          storeKeys: [canonicalKey],
          store: mocks.loadSessionStoreMock(storePath),
        };
      },
    },
    accessor: {
      listSessionEntriesCore: listEntries,
      listSessionEntriesReadOnly: listEntries,
      loadSessionEntry: loadEntry,
      loadSessionEntryReadOnly: loadEntry,
      upsertSessionEntryCore: async (scope: unknown, patch: SessionEntry) =>
        await mocks.upsertSessionEntryMock(scope, patch),
    },
    readRuntime: {
      withSessionEntryReadOnlyInWorker: async <T>(
        scope: SessionEntryReadScope,
        assertCurrent: () => void,
        consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<T>,
      ): Promise<T> => {
        assertCurrent();
        const result = await consume({ ok: true, value: loadEntry(scope) });
        assertCurrent();
        return result;
      },
    },
  };
}
