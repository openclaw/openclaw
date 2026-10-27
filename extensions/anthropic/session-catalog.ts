import fs from "node:fs/promises";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import {
  createSessionCatalogAdoptionCoordinator,
  sessionCatalogPaging,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_MODEL_REF } from "./cli-constants.js";
import {
  adoptedSessionKey,
  adoptedSourceKey,
  CLAUDE_LOCAL_SESSION_HOST_ID,
} from "./session-catalog-adoption.js";
import { isExactClaudeSessionCursor } from "./session-catalog-cursor.js";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import { importClaudeHistory } from "./session-catalog-history.js";
import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";
import {
  assertClaudeLocalAccess,
  readBoundedClaudeHistory,
  listClaudeSessionCatalog,
  readClaudeSessionTranscript,
  resolveNodeClaudeRecord,
} from "./session-catalog-listing.js";
import { MAX_TRANSCRIPT_LIMIT, readTranscriptParams } from "./session-catalog-parsing.js";
import {
  type BoundClaudeSession,
  listBoundClaudeSessions,
  currentClaudeSessionCatalogConfig,
  resolveClaudeCliRoutedModelId,
} from "./session-catalog-runtime.js";
import { configuredClaudeConfigDir, gatewayClaudeScanOptions } from "./session-catalog-scan.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  ClaudeCatalogParamsError,
  isResumableClaudeSource,
} from "./session-catalog-shared.js";
import * as catalogTerminal from "./session-catalog-terminal.js";
import { collectTranscriptText, type ClaudeTranscriptItem } from "./session-catalog-transcript.js";
import type {
  ClaudeSessionCatalogHost,
  ClaudeSessionCatalogSession,
} from "./session-catalog-types.js";
import * as upstream from "./session-upstream-activity.js";

export * from "./session-catalog-shared.js";
export {
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog-listing.js";

const CLAUDE_TRANSCRIPT_TYPES = new Map<string, SessionCatalogTranscriptItem["type"]>([
  ["userMessage", "userMessage"],
  ["agentMessage", "agentMessage"],
  ["reasoning", "reasoning"],
  ["toolCall", "toolCall"],
  ["toolResult", "toolResult"],
]);
const CLAUDE_BLOCK_TYPES = new Map<unknown, SessionCatalogTranscriptItem["type"]>([
  ["thinking", "reasoning"],
  ["tool_use", "toolCall"],
  ["tool_result", "toolResult"],
]);

const continueClaudeAdoption =
  createSessionCatalogAdoptionCoordinator<Awaited<ReturnType<typeof upstream.linkContinued>>>();

function toGenericClaudeItems(item: ClaudeTranscriptItem): SessionCatalogTranscriptItem[] {
  const common = {
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.truncated ? { truncated: true } : {}),
  };
  if (!Array.isArray(item.content)) {
    return [
      {
        ...common,
        ...(item.uuid ? { id: item.uuid } : {}),
        // Oversized rows lose their native blocks; their flattened text can contain
        // reasoning or tools, so consumers must not treat it as ordinary prose.
        type: item.truncated ? "other" : (CLAUDE_TRANSCRIPT_TYPES.get(item.type) ?? "other"),
        ...(item.text ? { text: item.text } : {}),
      },
    ];
  }
  // Mixed tools/reasoning must not inherit the row's user or assistant label.
  return item.content
    .flatMap((block, index): SessionCatalogTranscriptItem[] => {
      if (!isRecord(block)) {
        return [];
      }
      const messageType = item.type === "userMessage" ? "userMessage" : "agentMessage";
      const type =
        block.type === "text" ? messageType : (CLAUDE_BLOCK_TYPES.get(block.type) ?? "other");
      const fragments: string[] = [];
      if (block.type === "tool_use") {
        fragments.push(typeof block.name === "string" ? block.name : "tool");
        if (block.input !== undefined) {
          fragments.push(JSON.stringify(block.input));
        }
      } else {
        const content =
          block.type === "text" ? (typeof block.text === "string" ? block.text : "") : block;
        collectTranscriptText(content, fragments);
      }
      const text = fragments.join("\n\n");
      return [
        {
          ...common,
          ...(item.uuid ? { id: `${item.uuid}:${index}` } : {}),
          type,
          ...(text ? { text } : {}),
        },
      ];
    })
    .toReversed();
}

function toGenericClaudeHost(
  host: ClaudeSessionCatalogHost,
  bound: ReadonlyMap<string, BoundClaudeSession>,
  cliAvailable: boolean,
): SessionCatalogHost {
  return {
    hostId: host.hostId,
    label: host.label,
    kind: host.kind,
    connected: host.connected,
    canStartTerminal: host.kind === "gateway" ? cliAvailable : host.canStartTerminal === true,
    ...(host.nodeId ? { nodeId: host.nodeId } : {}),
    sessions: host.sessions.flatMap((session) => {
      const boundSession = bound.get(adoptedSourceKey(host.hostId, session.threadId));
      // An OpenClaw session that merely routes its turns through the Claude CLI
      // writes a thread here, but it is not a Claude Code conversation: it owns a
      // sidebar row of its own. Listing it would hide that row inside this catalog
      // and pull the session out of the group the operator filed it under.
      if (boundSession && !boundSession.adopted) {
        return [];
      }
      const terminal = catalogTerminal.terminalEligibility(host, session.source, cliAvailable);
      const nodeCli =
        host.kind === "node" && host.canContinueClaude === true && session.source === "claude-cli";
      const existingSessionKey = boundSession?.sessionKey;
      // Already-adopted rows stay continuable even if node policy later denies
      // the run command: continue only returns the existing session key, and
      // the turn itself still fails closed at invoke time.
      const continuable = terminal.localResumable || nodeCli || Boolean(existingSessionKey);
      const { name, recencyAt, ...metadata } = session;
      return [
        {
          ...metadata,
          ...(name ? { name } : {}),
          ...(recencyAt != null ? { recencyAt } : {}),
          ...(continuable && existingSessionKey ? { sessionKey: existingSessionKey } : {}),
          canContinue: continuable,
          canArchive: false,
          canOpenTerminal: terminal.canOpenTerminal,
        },
      ];
    }),
    ...(host.nextCursor ? { nextCursor: host.nextCursor } : {}),
    ...(host.error ? { error: host.error } : {}),
  };
}

export function createClaudeSessionCatalogRuntime(
  api: OpenClawPluginApi,
): Required<
  Pick<
    SessionCatalogProvider,
    | "list"
    | "read"
    | "continueSession"
    | "startTerminalSession"
    | "openTerminal"
    | "checkUpstreamActivity"
  >
> {
  return {
    list: async (query) => {
      const bound = listBoundClaudeSessions(api, query.agentId, query.sessionEntries);
      const localCliAvailable = catalogTerminal.isClaudeCliAvailable();
      const {
        allowProcessHomeFallback,
        allowPartialResults: _allowPartialResults,
        agentId: _agentId,
        listNodes,
        onHost,
        waitUntil,
        signal,
        sessionEntries: _sessionEntries,
        ...gatewayQuery
      } = query;
      const mapHost = (host: ClaudeSessionCatalogHost) =>
        toGenericClaudeHost(host, bound, localCliAvailable);
      const result = await listClaudeSessionCatalog({
        runtime: api.runtime,
        query: gatewayQuery,
        allowProcessHomeFallback,
        listNodes,
        waitUntil,
        signal,
        ...(onHost ? { onHost: (host) => onHost(mapHost(host)) } : {}),
      });
      return result.hosts.map(mapHost);
    },
    read: async (request) => {
      const { threadId, limit, cursor } = readTranscriptParams({
        threadId: request.threadId,
        limit: request.limit,
        cursor: request.cursor,
      });
      const blockCursor = /^block:(\d+):(.+)$/u.exec(cursor ?? "");
      const skip = Number(blockCursor?.[1] ?? 0);
      if (!Number.isSafeInteger(skip) || (cursor?.startsWith("block:") && !blockCursor)) {
        throw new ClaudeCatalogParamsError("transcript cursor is invalid");
      }
      const page = await readClaudeSessionTranscript({
        runtime: api.runtime,
        hostId: request.hostId,
        threadId,
        cursor: blockCursor?.[2] ?? cursor,
        limit,
        allowProcessHomeFallback: request.allowProcessHomeFallback,
      });
      if (skip && !page.items.length) {
        throw new ClaudeCatalogParamsError("transcript cursor is invalid");
      }
      const projected = page.items.flatMap((row, index) => {
        const blocks = toGenericClaudeItems(row);
        const offset = index === 0 ? skip : 0;
        if (offset && offset >= blocks.length) {
          throw new ClaudeCatalogParamsError("transcript cursor is invalid");
        }
        return blocks.slice(offset).map((item, block) => ({ item, row, skip: offset + block }));
      });
      const { items } = sessionCatalogPaging.boundTranscriptPage(
        projected.map(({ item }) => item).toReversed(),
        limit,
        0,
      );
      for (const [index, item] of items.entries()) {
        if (item.text !== projected[index]?.item.text && projected[index]?.item.text) {
          item.truncated = true;
        }
      }
      const resume = projected[items.length];
      if (resume && !isExactClaudeSessionCursor(resume.row.resumeCursor)) {
        throw new Error("Update the Claude session node to page mixed transcript blocks");
      }
      // Native byte-end anchors use base64url (no colon), so the block prefix is
      // distinct. Anchors survive appends, changed page sizes, and byte-budget cuts.
      const nextCursor = resume
        ? `block:${resume.skip}:${resume.row.resumeCursor}`
        : page.nextCursor;
      return { ...page, items, nextCursor };
    },
    continueSession: async (request) => {
      assertClaudeLocalAccess(request.hostId, request.allowProcessHomeFallback);
      const agentId = resolveSessionAgentIdsStrict({
        config: api.config,
        agentId: request.agentId,
      }).sessionAgentId;
      const { hostId, threadId, allowProcessHomeFallback } = request;
      const scanOptions = {
        ...gatewayClaudeScanOptions(allowProcessHomeFallback),
        sessionId: threadId,
      };
      const sourceKey = adoptedSourceKey(hostId, threadId);
      const operationKey = `${agentId}\0${sourceKey}`;
      const linkSession = async (sessionKey: string, history?: ClaudeTranscriptItem[]) =>
        await upstream.linkContinued({
          sessionKey,
          hostId,
          threadId,
          ...(history ? { history } : {}),
          listLocalSessions: async () =>
            (await listClaudeSessions(resolveClaudeCatalogHomeDir(), scanOptions)).records,
          readRemote: async () =>
            (
              await readClaudeSessionTranscript({
                runtime: api.runtime,
                hostId,
                threadId,
                limit: 1,
                allowProcessHomeFallback,
              })
            ).items,
        });
      const existing = listBoundClaudeSessions(api, agentId).get(sourceKey)?.sessionKey;
      if (existing) {
        return await linkSession(existing);
      }
      let history: ClaudeTranscriptItem[] | undefined;
      return await continueClaudeAdoption({
        sourceKey: operationKey,
        findExisting: () => listBoundClaudeSessions(api, agentId).get(sourceKey)?.sessionKey,
        create: async () => {
          let nodeId: string | undefined;
          let record: ClaudeSessionCatalogSession;
          if (hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
            const localRecord = (
              await listClaudeSessions(resolveClaudeCatalogHomeDir(), scanOptions)
            ).records.find((candidate) => candidate.threadId === threadId);
            if (!localRecord || !isResumableClaudeSource(localRecord.source)) {
              throw new ClaudeCatalogParamsError(
                "only local Claude Code sessions can be continued",
              );
            }
            const source = await fs.stat(localRecord.filePath).catch(() => undefined);
            if (!source?.isFile()) {
              throw new ClaudeCatalogParamsError("Claude session transcript is unavailable");
            }
            record = localRecord;
          } else if (hostId.startsWith("node:")) {
            nodeId = hostId.slice("node:".length);
            const node = (await api.runtime.nodes.list()).nodes.find(
              (candidate) =>
                candidate.nodeId === nodeId &&
                candidate.connected === true &&
                candidate.commands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) &&
                candidate.commands.includes(CLAUDE_SESSION_READ_COMMAND) &&
                candidate.commands.includes(CLAUDE_CLI_NODE_RUN_COMMAND) &&
                candidate.invocableCommands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) === true &&
                candidate.invocableCommands.includes(CLAUDE_SESSION_READ_COMMAND) &&
                candidate.invocableCommands.includes(CLAUDE_CLI_NODE_RUN_COMMAND),
            );
            if (!node) {
              throw new ClaudeCatalogParamsError(
                "paired node does not permit Claude CLI session continuation",
              );
            }
            // Node rows stay CLI-only: desktop transcripts on nodes have no
            // node-side run command and remain view-only.
            const nodeRecord = await resolveNodeClaudeRecord({
              runtime: api.runtime,
              nodeId,
              threadId,
            });
            if (!nodeRecord || nodeRecord.source !== "claude-cli") {
              throw new ClaudeCatalogParamsError("only Claude CLI sessions can be continued");
            }
            record = nodeRecord;
          } else {
            throw new ClaudeCatalogParamsError("hostId is invalid");
          }
          // Narrowed local: afterCreate below needs a definite array, while the outer
          // `history` stays optional so complete() can link without a reread on races.
          const loadedHistory = await readBoundedClaudeHistory({
            runtime: api.runtime,
            hostId,
            threadId,
            allowProcessHomeFallback,
          });
          history = loadedHistory;
          const config = currentClaudeSessionCatalogConfig(api);
          // Adopt onto the model this agent actually routes to the CLI backend; the
          // packaged default may not be routed or allowed in an existing config.
          const model =
            resolveClaudeCliRoutedModelId(config, agentId) ??
            CLAUDE_CLI_DEFAULT_MODEL_REF.slice(`${CLAUDE_CLI_BACKEND_ID}/`.length);
          const marker = {
            sourceThreadId: threadId,
            ...(hostId !== CLAUDE_LOCAL_SESSION_HOST_ID ? { sourceHostId: hostId } : {}),
          };
          const created = await api.runtime.agent.session.createSessionEntry({
            cfg: config,
            key: adoptedSessionKey(hostId, threadId),
            agentId,
            recoverMatchingInitialEntry: true,
            ...(record.name ? { displayName: record.name } : {}),
            ...(record.cwd ? { spawnedCwd: record.cwd } : {}),
            ...(nodeId ? { execNode: nodeId, ...(record.cwd ? { execCwd: record.cwd } : {}) } : {}),
            initialEntry: {
              ...(record.color ? { color: record.color } : {}),
              cliBackendId: CLAUDE_CLI_BACKEND_ID,
              model,
              modelSelectionLocked: true,
              pluginOwnerId: api.id,
              cliSessionBinding: { sessionId: threadId, forceReuse: true, forkNextResume: true },
              pluginExtensions: { anthropic: { sessionCatalog: marker } },
            },
            afterCreate: async (entry) => {
              await importClaudeHistory({
                items: loadedHistory,
                threadId,
                sessionId: entry.sessionId,
                sessionKey: entry.key,
                agentId: entry.agentId,
                storePath: api.runtime.agent.session.resolveStorePath(config.session?.store, {
                  agentId: entry.agentId,
                }),
                ...(record.cwd ? { cwd: record.cwd } : {}),
                config,
              });
              return { pluginExtensions: { anthropic: { sessionCatalog: marker } } };
            },
          });
          return { sessionKey: created.key };
        },
        complete: async (continued) => await linkSession(continued.sessionKey, history),
      });
    },
    startTerminalSession: async (request) => {
      // Node launches run in the paired node's environment, not gateway HOME;
      // only local starts fall under the process-HOME isolation guard.
      if (!request.nodeId) {
        if (request.hostId && request.hostId !== CLAUDE_LOCAL_SESSION_HOST_ID) {
          throw new ClaudeCatalogParamsError(
            "Claude terminal host is unavailable; select a listed host",
          );
        }
        assertClaudeLocalAccess(CLAUDE_LOCAL_SESSION_HOST_ID, request.allowProcessHomeFallback);
      }
      return await catalogTerminal.startClaudeCatalogTerminal(request);
    },
    openTerminal: async (request) => {
      assertClaudeLocalAccess(request.hostId, request.allowProcessHomeFallback);
      return await catalogTerminal.openClaudeCatalogTerminal({
        api,
        ...request,
        listClaudeSessions: async () =>
          (
            await listClaudeSessions(resolveClaudeCatalogHomeDir(), {
              ...gatewayClaudeScanOptions(request.allowProcessHomeFallback),
              sessionId: request.threadId,
            })
          ).records,
        resolveNodeClaudeRecord,
      });
    },
    checkUpstreamActivity: async (probes, policy) => {
      const localAllowed =
        policy?.allowProcessHomeFallback !== false || configuredClaudeConfigDir() !== undefined;
      const eligible = probes.filter(
        (probe) => probe.hostId !== CLAUDE_LOCAL_SESSION_HOST_ID || localAllowed,
      );
      return await upstream.checkClaudeUpstreamActivity(eligible, async (probe) => {
        return (
          await readClaudeSessionTranscript({
            runtime: api.runtime,
            hostId: probe.hostId,
            threadId: probe.threadId,
            limit: MAX_TRANSCRIPT_LIMIT,
            allowProcessHomeFallback: policy?.allowProcessHomeFallback,
          })
        ).items;
      });
    },
  };
}
