import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  sessionCatalogPaging,
  type SessionCatalogSession,
  type SessionCatalogSourceProfileRelation,
} from "openclaw/plugin-sdk/session-catalog";
import { prepareStoredSessionControlUiPathResolver } from "openclaw/plugin-sdk/session-discussion";
import type {
  SessionEntry,
  SessionStoreSelectedEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  prepareSessionCatalogSourceActorProjector,
  readSessionTranscriptCatalogPage,
  readSessionTranscriptCatalogTitleAsync,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sessionShareSelection } from "./config.js";

export const SESSION_SHARE_LIST_COMMAND = "openclaw.sessions.list.v1";
export const SESSION_SHARE_READ_COMMAND = "openclaw.sessions.read.v1";
export const SESSION_SHARE_CATALOG_LIST_COMMAND = "openclaw.sessions.catalog.list.v1";
export const SESSION_SHARE_CATALOG_READ_COMMAND = "openclaw.sessions.catalog.read.v1";
export const SESSION_SHARE_COMMANDS = [SESSION_SHARE_LIST_COMMAND, SESSION_SHARE_READ_COMMAND];
export const SESSION_SHARE_CATALOG_COMMANDS = [
  SESSION_SHARE_CATALOG_LIST_COMMAND,
  SESSION_SHARE_CATALOG_READ_COMMAND,
];

const parameterMessages = {
  listNotObject: "Session list parameters must be an object",
  unknownListParameter: (key: string) => `Unknown session list parameter: ${key}`,
  invalidSearchTerm: "searchTerm must be a non-empty string of at most 500 characters",
  readNotObject: "Session read parameters must be an object",
  unknownReadParameter: (key: string) => `Unknown session read parameter: ${key}`,
  invalidThreadId: "threadId must be a non-empty session key of at most 512 characters",
};

function parseNodeParams(paramsJSON?: string | null): unknown {
  return paramsJSON ? JSON.parse(paramsJSON) : undefined;
}

// The host's relation resolver marks an unknown or ambiguous target with this closed code.
// Node transports flatten thrown errors to text, so the list answers with a typed page instead.
export function isUnresolvedRelationError(error: unknown): boolean {
  return isRecord(error) && error.code === "PROFILE_RELATION_UNRESOLVED";
}

function isSharedEntry(
  groups: ReadonlySet<string>,
  { sessionKey, entry }: { sessionKey: string; entry: SessionEntry },
) {
  return (
    entry.category !== undefined &&
    groups.has(entry.category) &&
    entry.incognito !== true &&
    entry.visibility !== "draft" &&
    !isSubagentSessionKey(sessionKey) &&
    entry.createdVia !== "spawn" &&
    !entry.spawnedBy?.trim() &&
    !/^agent:[^:]+:catalog:/i.test(sessionKey)
  );
}

export type SessionShareSourceAuthority = {
  assertCurrent: () => void;
  /** Synchronous consumer called before the native source guards are released. */
  consumeResult?: (payload: unknown) => void;
};

function sourceSelection(api: OpenClawPluginApi, authority?: SessionShareSourceAuthority) {
  authority?.assertCurrent();
  return sessionShareSelection(api.runtime.config.current());
}

function withSharedEntries<T>(
  api: OpenClawPluginApi,
  selected: readonly { agentId: string; storePath: string; sessionKey: string }[],
  consume: (entries: SessionStoreSelectedEntry[]) => T,
  authority?: SessionShareSourceAuthority,
  profileRelation?: SessionCatalogSourceProfileRelation,
): Promise<T> {
  const config = api.runtime.config.current();
  const selection = sourceSelection(api, authority);
  const selectionKey = JSON.stringify(selection);
  const groups = new Set(selection?.groups ?? []);
  const stores = (selection ? listAgentIds(config) : [])
    .filter((agentId) => selected.some((entry) => entry.agentId === agentId))
    .toSorted()
    .flatMap((agentId) => {
      const storePath = api.runtime.agent.session.resolveStorePath(config.session?.store, {
        agentId,
      });
      const sessionKeys = selected
        .filter((entry) => entry.agentId === agentId && entry.storePath === storePath)
        .map((entry) => entry.sessionKey);
      return sessionKeys.length ? [{ agentId, storePath, sessionKeys }] : [];
    });
  return api.runtime.agent.session.withSessionEntriesAsync(
    {
      stores,
      involvingProfileId: selection?.involvingProfileId,
      profileRelation,
    },
    (entries) => {
      // Configuration can be edited in place while either worker prepares its facts.
      const current = api.runtime.config.current();
      if (
        JSON.stringify(sourceSelection(api, authority)) !== selectionKey ||
        stores.some(
          ({ agentId, storePath }) =>
            !listAgentIds(current).includes(agentId) ||
            api.runtime.agent.session.resolveStorePath(current.session?.store, { agentId }) !==
              storePath,
        )
      ) {
        throw new Error("Session is no longer shared. Refresh the session catalog.");
      }
      return consume(entries.filter((session) => isSharedEntry(groups, session)));
    },
  );
}

export function createSessionShareNodeCommands(
  api: OpenClawPluginApi,
  authority?: SessionShareSourceAuthority,
  catalog = false,
): OpenClawPluginNodeHostCommand[] {
  const source = { pluginId: "session-share", sourceDomain: "openclaw" };
  const serializeResult = (payload: unknown) => {
    const serialized = JSON.stringify(payload);
    authority?.assertCurrent();
    authority?.consumeResult?.(payload);
    return serialized;
  };
  let readersConfig: ReturnType<typeof api.runtime.config.current> | undefined;
  const readers = new Map<
    string,
    ReturnType<typeof api.runtime.agent.session.createSessionEntryListReader>
  >();
  async function readSharedEntries(profileRelation?: SessionCatalogSourceProfileRelation) {
    const config = api.runtime.config.current();
    if (config !== readersConfig) {
      readers.clear();
      readersConfig = config;
    }
    const selection = sourceSelection(api, authority);
    const selectionKey = JSON.stringify(selection);
    const groups = new Set(selection?.groups ?? []);
    const sessions: Array<SessionStoreSelectedEntry & { assertSourceCurrent: () => void }> = [];
    const active = new Set<string>();
    for (const agentId of groups.size ? listAgentIds(config).toSorted() : []) {
      const storePath = api.runtime.agent.session.resolveStorePath(config.session?.store, {
        agentId,
      });
      const key = JSON.stringify([agentId, storePath]);
      active.add(key);
      let read = readers.get(key);
      if (!read) {
        read = api.runtime.agent.session.createSessionEntryListReader({ agentId, storePath });
        readers.set(key, read);
      }
      const snapshot = await (await read)();
      const current = api.runtime.config.current();
      if (
        JSON.stringify(sourceSelection(api, authority)) !== selectionKey ||
        !listAgentIds(current).includes(agentId) ||
        api.runtime.agent.session.resolveStorePath(current.session?.store, { agentId }) !==
          storePath
      ) {
        throw new Error("Session sharing configuration changed. Refresh the session catalog.");
      }
      for (const session of snapshot.entries) {
        if (isSharedEntry(groups, session)) {
          sessions.push({
            ...session,
            agentId,
            storePath,
            assertSourceCurrent: snapshot.assertCurrent,
          });
        }
      }
    }
    for (const key of readers.keys()) {
      if (!active.has(key)) {
        readers.delete(key);
      }
    }
    if (selection?.involvingProfileId === undefined && !profileRelation) {
      return sessions;
    }
    // Inventory stays worker-owned. The selected cohort gets current canonical
    // person membership before pagination, then is checked again at disclosure.
    return withSharedEntries(
      api,
      sessions,
      (current) => {
        sessions.forEach((session) => session.assertSourceCurrent());
        const selected = new Set(
          current.map(({ agentId, storePath, sessionKey, entry }) =>
            JSON.stringify([agentId, storePath, sessionKey, entry.sessionId]),
          ),
        );
        return sessions.filter(({ agentId, storePath, sessionKey, entry }) =>
          selected.has(JSON.stringify([agentId, storePath, sessionKey, entry.sessionId])),
        );
      },
      authority,
      profileRelation,
    );
  }
  const commands: OpenClawPluginNodeHostCommand[] = [
    {
      command: catalog ? SESSION_SHARE_CATALOG_LIST_COMMAND : SESSION_SHARE_LIST_COMMAND,
      hasActiveWork: () => false,
      cap: "openclaw-sessions",
      dangerous: false,
      isAvailable: ({ config }) => sessionShareSelection(config) !== undefined,
      async handle(paramsJSON) {
        const raw = parseNodeParams(paramsJSON);
        let includeLinks = false;
        let listParams = raw;
        if (catalog && isRecord(raw)) {
          const { includeOriginalPath, ...rest } = raw;
          if (includeOriginalPath !== undefined && typeof includeOriginalPath !== "boolean") {
            throw new Error("includeOriginalPath must be a boolean");
          }
          includeLinks = includeOriginalPath === true;
          listParams = rest;
        }
        const params = sessionCatalogPaging.parseListParams(listParams, {
          searchMaxLength: 500,
          messages: parameterMessages,
          supportsProfileRelation: catalog,
        });
        const resolveOriginalPath = includeLinks
          ? await prepareStoredSessionControlUiPathResolver()
          : undefined;
        const offset = sessionCatalogPaging.decodeCursor(params.cursor, params.profileRelation);
        const search = params.searchTerm?.toLowerCase().normalize("NFC");
        let shared: Awaited<ReturnType<typeof readSharedEntries>>;
        try {
          shared = await readSharedEntries(params.profileRelation);
        } catch (error) {
          if (!params.profileRelation || !isUnresolvedRelationError(error)) {
            throw error;
          }
          return serializeResult({ sessions: [], relationUnresolved: true });
        }
        const sessions = [];
        for (const { agentId, sessionKey, storePath, entry, assertSourceCurrent } of shared) {
          const name = search
            ? await readSessionTranscriptCatalogTitleAsync({
                agentId,
                sessionKey,
                storePath,
                entry,
              })
            : undefined;
          if (
            search &&
            !name?.toLowerCase().normalize("NFC").includes(search) &&
            !sessionKey.toLowerCase().normalize("NFC").includes(search)
          ) {
            continue;
          }
          sessions.push({
            agentId,
            storePath,
            threadId: sessionKey,
            name,
            entry,
            assertSourceCurrent,
            recencyAt: Math.max(
              entry.updatedAt,
              entry.lastInteractionAt ?? 0,
              entry.lastActivityAt ?? 0,
            ),
          });
        }
        sessions.sort(
          (left, right) =>
            right.recencyAt - left.recencyAt || left.threadId.localeCompare(right.threadId),
        );
        const selected = sessions.slice(offset, offset + params.limit);
        if (!search) {
          for (const session of selected) {
            session.name = await readSessionTranscriptCatalogTitleAsync({
              agentId: session.agentId,
              sessionKey: session.threadId,
              storePath: session.storePath,
              entry: session.entry,
            });
          }
        }
        const sourceAssertions = new Set(selected.map((session) => session.assertSourceCurrent));
        const projectCreator = await prepareSessionCatalogSourceActorProjector({
          ...source,
          actors: selected.map(({ entry }) => entry.createdActor),
        });
        sourceAssertions.forEach((assertCurrent) => assertCurrent());
        return withSharedEntries(
          api,
          selected.map((session) => ({
            agentId: session.agentId,
            storePath: session.storePath,
            sessionKey: session.threadId,
          })),
          (current) => {
            sourceAssertions.forEach((assertCurrent) => assertCurrent());
            if (
              selected.some(
                (session) =>
                  !current.some(
                    ({ agentId, sessionKey, storePath, entry }) =>
                      agentId === session.agentId &&
                      sessionKey === session.threadId &&
                      storePath === session.storePath &&
                      entry.sessionId === session.entry.sessionId,
                  ),
              )
            ) {
              throw new Error("Session is no longer shared. Refresh the session catalog.");
            }
            const page = selected.map(
              ({
                agentId,
                threadId,
                name,
                entry,
                recencyAt,
              }): SessionCatalogSession & { originalPath?: string } => {
                const archived = entry.archivedAt !== undefined;
                const cwd =
                  entry.execCwd ??
                  entry.spawnedCwd ??
                  entry.spawnedWorkspaceDir ??
                  entry.worktree?.canonicalWorkspaceDir ??
                  entry.worktree?.repoRoot;
                return {
                  threadId,
                  originalPath: resolveOriginalPath?.({
                    config: api.runtime.config.current(),
                    agentId,
                    sessionKey: threadId,
                  }),
                  name,
                  color: entry.color,
                  cwd: cwd ? cwd.slice(0, 6000) : undefined,
                  status: archived ? "archived" : "idle",
                  createdAt: entry.createdAt,
                  updatedAt: entry.updatedAt,
                  recencyAt,
                  gitBranch: entry.worktree?.branch
                    ? entry.worktree.branch.slice(0, 6000)
                    : undefined,
                  archived,
                  canContinue: false,
                  canArchive: false,
                  canOpenTerminal: false,
                  createdActor: projectCreator(entry.createdActor),
                };
              },
            );
            return serializeResult({
              sessions: page,
              ...(offset + page.length < sessions.length
                ? {
                    nextCursor: sessionCatalogPaging.encodeCursor(
                      offset + page.length,
                      params.profileRelation,
                    ),
                  }
                : {}),
            });
          },
          authority,
          params.profileRelation,
        );
      },
    },
    {
      command: catalog ? SESSION_SHARE_CATALOG_READ_COMMAND : SESSION_SHARE_READ_COMMAND,
      hasActiveWork: () => false,
      cap: "openclaw-sessions",
      dangerous: false,
      isAvailable: ({ config }) => sessionShareSelection(config) !== undefined,
      async handle(paramsJSON) {
        const params = sessionCatalogPaging.parseReadParams(parseNodeParams(paramsJSON), {
          threadIdMaxLength: 512,
          threadIdPattern: /^[^\0\r\n]+$/,
          cursorMaxLength: catalog ? 2048 : 1200,
          messages: parameterMessages,
          supportsProfileRelation: catalog,
        });
        const session = (await readSharedEntries(params.profileRelation)).find(
          ({ sessionKey }) => sessionKey === params.threadId,
        );
        if (!session) {
          throw new Error(
            "Session is not shared. The session must match the source operator's filters and stay eligible.",
          );
        }
        session.assertSourceCurrent();
        let assertActorsCurrent = () => {};
        const page = await readSessionTranscriptCatalogPage(
          {
            ...source,
            agentId: session.agentId,
            sessionKey: session.sessionKey,
            storePath: session.storePath,
            limit: params.limit,
            cursor: sessionCatalogPaging.decodeScopedCursor(params.cursor, params.profileRelation),
          },
          (assertCurrent) => {
            assertActorsCurrent = assertCurrent;
          },
        );
        session.assertSourceCurrent();
        // The final worker callback retains all sources through synchronous serialization.
        return withSharedEntries(
          api,
          [session],
          (current) => {
            session.assertSourceCurrent();
            if (
              !current.some(
                ({ agentId, sessionKey, storePath, entry }) =>
                  agentId === session.agentId &&
                  sessionKey === session.sessionKey &&
                  storePath === session.storePath &&
                  entry.sessionId === session.entry.sessionId,
              )
            ) {
              throw new Error("Session is no longer shared. Refresh the session catalog.");
            }
            assertActorsCurrent();
            return serializeResult({
              threadId: params.threadId,
              ...page,
              ...(page.nextCursor
                ? {
                    nextCursor: sessionCatalogPaging.encodeScopedCursor(
                      page.nextCursor,
                      params.profileRelation,
                    ),
                  }
                : {}),
            });
          },
          authority,
          params.profileRelation,
        );
      },
    },
  ];
  return catalog
    ? commands
    : [...commands, ...createSessionShareNodeCommands(api, authority, true)];
}
