import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  sessionCatalogPaging,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  prepareSessionCatalogSourceActorProjector,
  readSessionTranscriptCatalogPage,
  readSessionTranscriptCatalogTitle,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sessionShareGroups } from "./config.js";

export const SESSION_SHARE_LIST_COMMAND = "openclaw.sessions.list.v1";
export const SESSION_SHARE_READ_COMMAND = "openclaw.sessions.read.v1";
export const SESSION_SHARE_COMMANDS = [SESSION_SHARE_LIST_COMMAND, SESSION_SHARE_READ_COMMAND];

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

function sharedEntries(
  api: OpenClawPluginApi,
  selected: readonly { agentId: string; storePath: string; sessionKey: string }[],
) {
  const config = api.runtime.config.current();
  const groups = new Set(sessionShareGroups(config));
  if (groups.size === 0) {
    return [];
  }
  return listAgentIds(config)
    .filter((agentId) => selected.some((entry) => entry.agentId === agentId))
    .toSorted()
    .flatMap((agentId) => {
      const storePath = api.runtime.agent.session.resolveStorePath(config.session?.store, {
        agentId,
      });
      const sessionKeys = selected
        .filter((entry) => entry.agentId === agentId && entry.storePath === storePath)
        .map((entry) => entry.sessionKey);
      if (sessionKeys.length === 0) {
        return [];
      }
      return api.runtime.agent.session
        .listSessionEntries({
          agentId,
          storePath,
          readOnly: true,
          includeParticipants: false,
          sessionKeys,
        })
        .map((session) => Object.assign({}, session, { agentId, storePath }));
    })
    .filter((session) => isSharedEntry(groups, session));
}

export function createSessionShareNodeCommands(
  api: OpenClawPluginApi,
): OpenClawPluginNodeHostCommand[] {
  const source = { pluginId: "session-share", sourceDomain: "openclaw" };
  let readersConfig: ReturnType<typeof api.runtime.config.current> | undefined;
  const readers = new Map<
    string,
    ReturnType<typeof api.runtime.agent.session.createSessionEntryListReader>
  >();
  async function readSharedEntries() {
    const config = api.runtime.config.current();
    if (config !== readersConfig) {
      readers.clear();
      readersConfig = config;
    }
    const groups = new Set(sessionShareGroups(config));
    const sessions: Array<
      ReturnType<typeof sharedEntries>[number] & { assertSourceCurrent: () => void }
    > = [];
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
      if (api.runtime.config.current() !== config) {
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
    return sessions;
  }
  return [
    {
      command: SESSION_SHARE_LIST_COMMAND,
      hasActiveWork: () => false,
      cap: "openclaw-sessions",
      dangerous: false,
      isAvailable: ({ config }) => sessionShareGroups(config).length > 0,
      async handle(paramsJSON) {
        const params = sessionCatalogPaging.parseListParams(parseNodeParams(paramsJSON), {
          searchMaxLength: 500,
          messages: parameterMessages,
        });
        const offset = sessionCatalogPaging.decodeCursor(params.cursor);
        const search = params.searchTerm?.toLowerCase();
        const sessions = [];
        for (const {
          agentId,
          sessionKey,
          storePath,
          entry,
          assertSourceCurrent,
        } of await readSharedEntries()) {
          const name = search
            ? readSessionTranscriptCatalogTitle({ agentId, sessionKey, storePath, entry })
            : undefined;
          if (
            search &&
            !name?.toLowerCase().includes(search) &&
            !sessionKey.toLowerCase().includes(search)
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
            session.name = readSessionTranscriptCatalogTitle({
              agentId: session.agentId,
              sessionKey: session.threadId,
              storePath: session.storePath,
              entry: session.entry,
            });
          }
        }
        const sourceAssertions = new Set(selected.map((session) => session.assertSourceCurrent));
        sourceAssertions.forEach((assertCurrent) => assertCurrent());
        const projectCreator = await prepareSessionCatalogSourceActorProjector({
          ...source,
          actors: selected.map(({ entry }) => entry.createdActor),
        });
        sourceAssertions.forEach((assertCurrent) => assertCurrent());
        const current = sharedEntries(
          api,
          selected.map((session) => ({
            agentId: session.agentId,
            storePath: session.storePath,
            sessionKey: session.threadId,
          })),
        );
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
        const page = selected.map(({ threadId, name, entry, recencyAt }): SessionCatalogSession => {
          const archived = entry.archivedAt !== undefined;
          const cwd =
            entry.execCwd ??
            entry.spawnedCwd ??
            entry.spawnedWorkspaceDir ??
            entry.worktree?.canonicalWorkspaceDir ??
            entry.worktree?.repoRoot;
          return {
            threadId,
            name,
            color: entry.color,
            cwd: cwd ? cwd.slice(0, 6000) : undefined,
            status: archived ? "archived" : "idle",
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            recencyAt,
            gitBranch: entry.worktree?.branch ? entry.worktree.branch.slice(0, 6000) : undefined,
            archived,
            canContinue: false,
            canArchive: false,
            canOpenTerminal: false,
            createdActor: projectCreator(entry.createdActor),
          };
        });
        return JSON.stringify({
          sessions: page,
          ...(offset + page.length < sessions.length
            ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + page.length) }
            : {}),
        });
      },
    },
    {
      command: SESSION_SHARE_READ_COMMAND,
      hasActiveWork: () => false,
      cap: "openclaw-sessions",
      dangerous: false,
      isAvailable: ({ config }) => sessionShareGroups(config).length > 0,
      async handle(paramsJSON) {
        const params = sessionCatalogPaging.parseReadParams(parseNodeParams(paramsJSON), {
          threadIdMaxLength: 512,
          threadIdPattern: /^[^\0\r\n]+$/,
          cursorMaxLength: 1200,
          messages: parameterMessages,
        });
        const session = (await readSharedEntries()).find(
          ({ sessionKey }) => sessionKey === params.threadId,
        );
        if (!session) {
          throw new Error(
            "Session is not shared. The source operator must select its group and keep it non-draft.",
          );
        }
        session.assertSourceCurrent();
        const page = await readSessionTranscriptCatalogPage({
          ...source,
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          storePath: session.storePath,
          limit: params.limit,
          cursor: params.cursor,
        });
        session.assertSourceCurrent();
        // Group, store, and session changes revoke an in-flight read before publication.
        if (
          !sharedEntries(api, [session]).some(
            ({ agentId, sessionKey, storePath, entry }) =>
              agentId === session.agentId &&
              sessionKey === session.sessionKey &&
              storePath === session.storePath &&
              entry.sessionId === session.entry.sessionId,
          )
        ) {
          throw new Error("Session is no longer shared. Refresh the session catalog.");
        }
        return JSON.stringify({ threadId: session.sessionKey, ...page });
      },
    },
  ];
}
