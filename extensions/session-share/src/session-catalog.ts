import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  PluginServiceSchedulerV1,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  publishSessionCatalogHost,
  sessionCatalogPaging,
  type SessionCatalogHost,
  type SessionCatalogProvider,
  type SessionCatalogSession,
  type SessionCatalogSourceProfileRelation,
} from "openclaw/plugin-sdk/session-catalog";
import { prepareSessionCatalogGitHubLinker } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { observeCatalogRefresh } from "./catalog-refresh-diagnostics.js";
import { sessionShareNodeBinding } from "./config.js";
import {
  SESSION_SHARE_CATALOG_LIST_COMMAND,
  SESSION_SHARE_CATALOG_READ_COMMAND,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
} from "./node-commands.js";
import { sessionShareOriginalUrl } from "./original-url.js";
import {
  parseSessionSharePage,
  parseSessionShareTranscriptPage,
  type SessionShareSession,
} from "./wire.js";

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
function selectNodeCommands(node: CatalogNode) {
  const catalog = [SESSION_SHARE_CATALOG_LIST_COMMAND, SESSION_SHARE_CATALOG_READ_COMMAND].every(
    (command) => node.commands?.includes(command),
  );
  return catalog
    ? {
        catalog,
        list: SESSION_SHARE_CATALOG_LIST_COMMAND,
        read: SESSION_SHARE_CATALOG_READ_COMMAND,
      }
    : { catalog, list: SESSION_SHARE_LIST_COMMAND, read: SESSION_SHARE_READ_COMMAND };
}
type GitHubLinker = Awaited<ReturnType<typeof prepareSessionCatalogGitHubLinker>>;
type CatalogIdentity = NonNullable<NonNullable<SessionCatalogSession["createdActor"]>["identity"]>;
type NodeSnapshot = {
  key: string;
  profileRelation?: SessionCatalogSourceProfileRelation;
  appliedRelation?: SessionCatalogSourceProfileRelation;
  node: CatalogNode;
  config: ReturnType<PluginRuntime["config"]["current"]>;
  scope: PluginServiceSchedulerV1;
  sessions?: SessionShareSession[];
  refreshedAt: number;
  retryMs: number;
  pending?: Promise<void>;
  error?: SessionCatalogHost["error"];
};

const REFRESH_MS = 30_000;
const MAX_STALENESS_MS = 60_000;
const REFRESH_BUDGET_MS = 300_000;
const MAX_SNAPSHOTS = 32;
const MAX_REFRESHES = 4;
const MAX_SNAPSHOT_ROWS = 10_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

class SnapshotLimitError extends Error {
  constructor() {
    super(
      "Shared catalog exceeds the snapshot limit (10,000 sessions or 16 MiB). Reduce the shared groups on the source node.",
    );
  }
}

function namespaceIdentity(identity: CatalogIdentity, hostId: string): CatalogIdentity {
  // The receiver owns this namespace; the wire domain is untrusted and must not alias another node.
  return identity.type === "remote" && identity.pluginId === "session-share"
    ? { ...identity, domain: hostId }
    : identity;
}

function nodeLabel(node: CatalogNode): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function isSessionHost(node: CatalogNode): boolean {
  const { list, read } = selectNodeCommands(node);
  return [list, read].every((command) => node.commands?.includes(command));
}

function bindSession(
  session: SessionCatalogSession,
  hostId: string,
  owner: SessionCatalogSession["createdActor"],
  linkParticipant: GitHubLinker["linkParticipant"] | undefined,
): SessionCatalogSession {
  const sourceActor = session.createdActor;
  const portable =
    sourceActor?.type === "human" &&
    (sourceActor.identity?.type === "remote" || sourceActor.identity?.type === "observation");
  const actor = !portable && owner ? owner : sourceActor;
  if (!actor?.identity) {
    return actor ? { ...session, createdActor: actor } : session;
  }
  const participant = {
    identity: namespaceIdentity(actor.identity, hostId),
    label: actor.label,
    avatarUrl: actor.avatarUrl,
  };
  const linked = portable && linkParticipant ? linkParticipant(participant) : participant;
  return {
    ...session,
    createdActor: {
      ...actor,
      ...linked,
      ...(linked.identity.type === "profile" ? { id: linked.identity.id } : {}),
    },
  };
}

export function createSessionShareCatalog(api: OpenClawPluginApi): SessionCatalogProvider {
  const snapshots = new Map<string, NodeSnapshot>();
  const publicationGuards = new WeakMap<SessionCatalogHost, () => void>();
  let context: OpenClawPluginServiceContextV2 | undefined;
  let nextWarningAt = 0;
  const refreshes = createPermitPool(MAX_REFRESHES);
  const bindingFor = (nodeId: string) =>
    sessionShareNodeBinding(api.runtime.config.current(), nodeId);
  const bindSessions = async (nodeId: string, hostId: string, sessions: SessionShareSession[]) => {
    const binding = bindingFor(nodeId);
    const linker =
      binding.owner || binding.linkGitHubIdentities
        ? await prepareSessionCatalogGitHubLinker({
            owners: binding.owner ? [binding.owner] : [],
            participants: binding.linkGitHubIdentities
              ? sessions.flatMap(({ createdActor }) =>
                  createdActor?.identity ? [{ identity: createdActor.identity }] : [],
                )
              : [],
          })
        : undefined;
    const owner = binding.owner ? linker?.resolveOwner(binding.owner) : undefined;
    const linkParticipant = binding.linkGitHubIdentities ? linker?.linkParticipant : undefined;
    return sessions.map(({ originalPath, ...session }) =>
      Object.assign(bindSession(session, hostId, owner, linkParticipant), {
        originalUrl: sessionShareOriginalUrl(
          binding.controlUiOrigin,
          session.threadId,
          originalPath,
          binding.controlUiBasePath,
        ),
      }),
    );
  };
  const current = (entry: NodeSnapshot) =>
    !entry.scope.signal.aborted &&
    api.runtime.config.current() === entry.config &&
    snapshots.get(entry.key) === entry;
  const retire = (entry: NodeSnapshot) => {
    snapshots.delete(entry.key);
    entry.sessions = undefined;
    void entry.scope.stop();
  };
  const sameConnection = (entry: NodeSnapshot, node: CatalogNode | undefined) =>
    node?.connected &&
    isSessionHost(node) &&
    node.connectedAtMs === entry.node.connectedAtMs &&
    selectNodeCommands(node).catalog === selectNodeCommands(entry.node).catalog;

  function refresh(entry: NodeSnapshot, owner: OpenClawPluginServiceContextV2) {
    if (entry.pending) {
      return;
    }
    // Metadata from a previous source authorization is not a disclosure grant.
    entry.sessions = undefined;
    const completion = Promise.withResolvers<void>();
    entry.pending = completion.promise;
    const signal = entry.scope.signal;
    const release = () => completion.resolve();
    signal.addEventListener("abort", release, { once: true });
    entry.scope.schedule({
      id: "refresh",
      delayMs: 0,
      async run() {
        const releasePermit = await refreshes.acquire({ signal });
        const previousError = entry.error;
        let filterError: SessionCatalogHost["error"];
        try {
          if (!releasePermit || !current(entry)) {
            return;
          }
          const snapshot = await observeCatalogRefresh(
            async () => {
              const deadline = performance.now() + REFRESH_BUDGET_MS;
              const sessions: SessionShareSession[] = [];
              let commands = selectNodeCommands(entry.node);
              let includeLinks =
                commands.catalog && Boolean(bindingFor(entry.node.nodeId).controlUiOrigin);
              let cursor: string | undefined;
              let bytes = 0;
              let relation = entry.profileRelation;
              let retry: boolean;
              // Start over without the relation and let the receiver match rows client-side.
              const fallBackToClientFilter = () => {
                relation = undefined;
                cursor = undefined;
                sessions.length = 0;
                bytes = 0;
                retry = true;
                filterError = {
                  code: "FILTER_PARTIAL",
                  message:
                    "Source relationship filtering is unavailable. Showing authorized rows with client-side matching; check the identity link and catalog command approvals.",
                };
              };
              do {
                retry = false;
                if (!current(entry) || !owner.invokeNode) {
                  throw new Error("Session Share catalog owner retired");
                }
                const timeoutMs = Math.min(REFRESH_MS, Math.ceil(deadline - performance.now()));
                if (timeoutMs <= 0) {
                  throw new Error("Session Share catalog refresh timed out");
                }
                let raw: unknown;
                try {
                  raw = await owner.invokeNode({
                    nodeId: entry.node.nodeId,
                    command: commands.list,
                    params: {
                      limit: 100,
                      ...(includeLinks ? { includeOriginalPath: true } : {}),
                      ...(relation ? { profileRelation: relation } : {}),
                      ...(cursor ? { cursor } : {}),
                    },
                    timeoutMs,
                    signal,
                  });
                } catch (error) {
                  const details = asOptionalRecord(asOptionalRecord(error)?.details);
                  if (!relation || details?.reason !== "command not allowlisted") {
                    throw error;
                  }
                  // Only refreshed advertisement can select the legacy pair; a rejected
                  // catalog command is not permission to bypass the pair selection.
                  const latest = (await api.runtime.nodes.list()).nodes.find(
                    (node) => node.nodeId === entry.node.nodeId,
                  );
                  if (!latest?.connected || selectNodeCommands(latest).catalog) {
                    throw error;
                  }
                  entry.node = latest;
                  commands = selectNodeCommands(latest);
                  includeLinks = false;
                  fallBackToClientFilter();
                  continue;
                }
                const page = parseSessionSharePage(raw, includeLinks, relation);
                if (page.relationUnresolved) {
                  fallBackToClientFilter();
                  continue;
                }
                bytes += Buffer.byteLength(JSON.stringify(page));
                if (
                  sessions.length + page.sessions.length > MAX_SNAPSHOT_ROWS ||
                  bytes > MAX_SNAPSHOT_BYTES
                ) {
                  throw new SnapshotLimitError();
                }
                sessions.push(...page.sessions);
                if (
                  page.nextCursor !== undefined &&
                  sessionCatalogPaging.decodeCursor(page.nextCursor, relation) <=
                    sessionCatalogPaging.decodeCursor(cursor, relation)
                ) {
                  throw new Error("Session Share catalog cursor did not advance");
                }
                cursor = page.nextCursor;
              } while (retry || cursor !== undefined);
              entry.appliedRelation = relation;
              return sessions;
            },
            () => {
              const now = performance.now();
              if (now < nextWarningAt) {
                return false;
              }
              nextWarningAt = now + MAX_STALENESS_MS;
              return true;
            },
          );
          const connectedNode = (await api.runtime.nodes.list()).nodes.find(
            (candidate) => candidate.nodeId === entry.node.nodeId,
          );
          if (!current(entry)) {
            return;
          }
          if (!sameConnection(entry, connectedNode)) {
            retire(entry);
            return;
          }
          entry.sessions = snapshot;
          entry.refreshedAt = performance.now();
          entry.retryMs = REFRESH_MS;
          entry.error = filterError;
        } catch (error) {
          entry.retryMs = previousError ? Math.min(entry.retryMs * 2, 300_000) : REFRESH_MS;
          entry.error =
            error instanceof SnapshotLimitError
              ? { code: "CATALOG_TOO_LARGE", message: error.message }
              : {
                  code: "NODE_INVOKE_FAILED",
                  message:
                    "Cannot refresh OpenClaw sessions. Check the paired node's session-share configuration and connection.",
                };
        } finally {
          releasePermit?.();
          entry.pending = undefined;
          signal.removeEventListener("abort", release);
          completion.resolve();
          if (current(entry)) {
            entry.scope.schedule({
              id: "next-refresh",
              delayMs: entry.retryMs,
              run: () => refresh(entry, owner),
            });
          }
        }
      },
    });
  }

  function reconcile(nodes: CatalogNode[]) {
    const owner = context;
    if (!owner || owner.scheduler.signal.aborted) {
      return;
    }
    const config = api.runtime.config.current();
    for (const entry of snapshots.values()) {
      if (
        entry.config !== config ||
        !sameConnection(
          entry,
          nodes.find((node) => node.nodeId === entry.node.nodeId),
        )
      ) {
        retire(entry);
      }
    }
  }

  function admit(nodes: CatalogNode[], profileRelation?: SessionCatalogSourceProfileRelation) {
    const owner = context;
    if (!owner || owner.scheduler.signal.aborted) {
      return;
    }
    const config = api.runtime.config.current();
    const snapshotKey = (node: CatalogNode) =>
      JSON.stringify([node.nodeId, profileRelation ?? null]);
    // Protect only the snapshots this request needs. Other relations of the same node stay
    // evictable, or 32 relations on one node would block every new filter for good.
    const requested = new Set(nodes.map(snapshotKey));
    for (const node of nodes.filter((candidate) => candidate.connected)) {
      const key = snapshotKey(node);
      const existing = snapshots.get(key);
      if (existing) {
        snapshots.delete(key);
        snapshots.set(key, existing);
        // An explicit request always starts a fresh read, so source revocations show at once;
        // refresh() joins one already in flight instead of starting another.
        refresh(existing, owner);
        continue;
      }
      if (snapshots.size >= MAX_SNAPSHOTS) {
        const victim = Array.from(snapshots.values()).find(
          (candidate) => !candidate.pending && !requested.has(candidate.key),
        );
        if (!victim) {
          continue;
        }
        retire(victim);
      }
      const entry: NodeSnapshot = {
        key,
        profileRelation,
        node,
        config,
        scope: owner.scheduler.scope(),
        refreshedAt: 0,
        retryMs: REFRESH_MS,
      };
      snapshots.set(key, entry);
      refresh(entry, owner);
    }
  }

  api.registerService({
    id: "session-share-catalog",
    apiVersion: 2,
    start(ctx) {
      // The host joins the previous scheduler before starting a new service generation.
      context = ctx;
      ctx.scheduler.schedule({
        id: "nodes",
        delayMs: 0,
        everyMs: REFRESH_MS,
        async run() {
          if (!snapshots.size) {
            return;
          }
          const { nodes } = await api.runtime.nodes.list();
          if (context === ctx) {
            reconcile(nodes);
          }
        },
      });
    },
    stop() {
      context = undefined;
      snapshots.clear();
    },
  });

  async function listNode(
    node: CatalogNode,
    query: Parameters<SessionCatalogProvider["list"]>[0],
  ): Promise<SessionCatalogHost> {
    const hostId = `node:${node.nodeId}`;
    const { onHost, waitUntil, signal, allowPartialResults } = query;
    const search = query.search?.trim().toLowerCase().normalize("NFC");
    const cursor = query.cursors?.[hostId];
    const limit = sessionCatalogPaging.boundedLimit(query.limitPerHost);
    const common = {
      hostId,
      label: nodeLabel(node),
      kind: "node" as const,
      nodeId: node.nodeId,
      connected: node.connected === true,
    };
    const failed = (code: string, message: string): SessionCatalogHost => ({
      ...common,
      sessions: [],
      error: { code, message },
    });
    if (!node.connected) {
      return failed("NODE_OFFLINE", "Paired node is offline");
    }
    const supported = selectNodeCommands(node).catalog;
    const appliedRelation = supported ? query.profileRelation : undefined;
    const partial =
      query.profileRelation && !supported
        ? {
            code: "FILTER_PARTIAL",
            message:
              "Relationship filtering is unavailable on this source. Showing authorized rows with client-side matching; update the source and allow both catalog commands on the receiver.",
          }
        : undefined;
    const entry = snapshots.get(JSON.stringify([node.nodeId, appliedRelation ?? null]));
    const project = async (): Promise<SessionCatalogHost> => {
      if (!entry) {
        return failed(
          context ? "CATALOG_LOADING" : "NODE_INVOKE_FAILED",
          "Session Share is unavailable or busy. Refresh the catalog.",
        );
      }
      if (!current(entry)) {
        return failed("NODE_INVOKE_FAILED", "Session Share is unavailable. Refresh the catalog.");
      }
      if (!entry.sessions || performance.now() - entry.refreshedAt >= MAX_STALENESS_MS) {
        return entry.error
          ? { ...common, sessions: [], error: entry.error }
          : failed(
              "CATALOG_LOADING",
              "Session Share catalog is still loading. Refresh the catalog.",
            );
      }
      const publication = entry.sessions;
      const sessions = search
        ? entry.sessions.filter(
            (session) =>
              session.name?.toLowerCase().normalize("NFC").includes(search) ||
              session.threadId.toLowerCase().normalize("NFC").includes(search),
          )
        : entry.sessions;
      const offset = sessionCatalogPaging.decodeCursor(cursor, entry.appliedRelation);
      const selected = await bindSessions(
        node.nodeId,
        hostId,
        sessions.slice(offset, offset + limit),
      );
      if (!current(entry) || entry.sessions !== publication || signal?.aborted) {
        return failed("NODE_INVOKE_FAILED", "Session Share is unavailable. Refresh the catalog.");
      }
      const host: SessionCatalogHost = {
        ...common,
        sessions: selected,
        ...(entry.appliedRelation ? { profileRelation: entry.appliedRelation } : {}),
        ...((partial ?? entry.error) ? { error: partial ?? entry.error } : {}),
        ...(offset + limit < sessions.length
          ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + limit, entry.appliedRelation) }
          : {}),
      };
      // Other hosts and identity linking may yield before aggregate publication.
      publicationGuards.set(host, () => {
        if (!current(entry) || entry.sessions !== publication || signal?.aborted) {
          throw new Error("Session Share is unavailable. Refresh the catalog.");
        }
      });
      return host;
    };
    if (entry?.pending && !(allowPartialResults === true && onHost && waitUntil)) {
      signal?.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          entry.pending,
          new Promise<void>((resolve) => {
            abort = resolve;
            signal?.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        if (abort) {
          signal?.removeEventListener("abort", abort);
        }
      }
      signal?.throwIfAborted();
    }
    const host = await project();
    if ((entry && !current(entry)) || signal?.aborted) {
      return failed("NODE_INVOKE_FAILED", "Session Share is unavailable. Refresh the catalog.");
    }
    if (entry?.pending && allowPartialResults === true && onHost && waitUntil) {
      publishSessionCatalogHost(
        {
          waitUntil,
          onHost: (completedHost) => {
            if (completedHost && current(entry) && !signal?.aborted) {
              publicationGuards.get(completedHost)?.();
              onHost(completedHost);
            }
          },
        },
        entry.pending.then(() => (signal?.aborted ? undefined : project())),
      );
      if (!entry.error) {
        return { ...common, sessions: [], pending: true };
      }
    }
    publicationGuards.get(host)?.();
    onHost?.(host);
    return host;
  }

  return {
    id: "openclaw",
    label: "OpenClaw sessions",
    supportsProcessHomeIsolation: true,
    audience: "session-viewers",
    requiresFreshList: true,
    supportsProfileRelation: true,
    async list(query) {
      query.signal?.throwIfAborted();
      const config = api.runtime.config.current();
      let nodes: CatalogNode[];
      try {
        nodes = (await (query.listNodes?.() ?? api.runtime.nodes.list())).nodes;
      } catch {
        query.signal?.throwIfAborted();
        if (api.runtime.config.current() !== config) {
          return [];
        }
        // Preserve a retryable discovery failure without exposing node-runtime details.
        throw new Error("Cannot discover OpenClaw session sources. Refresh the catalog to retry.");
      }
      query.signal?.throwIfAborted();
      if (api.runtime.config.current() !== config) {
        return [];
      }
      reconcile(nodes);
      const requested = query.hostIds ? new Set(query.hostIds) : undefined;
      const eligible = nodes
        .filter(
          (node) => isSessionHost(node) && (!requested || requested.has(`node:${node.nodeId}`)),
        )
        .toSorted(
          (left, right) =>
            nodeLabel(left).localeCompare(nodeLabel(right)) ||
            left.nodeId.localeCompare(right.nodeId),
        )
        .slice(0, MAX_SNAPSHOTS);
      for (const node of eligible) {
        const supported = selectNodeCommands(node).catalog;
        admit([node], supported ? query.profileRelation : undefined);
      }
      const owner = context;
      const hosts = await Promise.all(
        eligible.map((node) => {
          query.signal?.throwIfAborted();
          return listNode(node, query);
        }),
      );
      query.signal?.throwIfAborted();
      if (context !== owner) {
        return [];
      }
      for (const host of hosts) {
        publicationGuards.get(host)?.();
      }
      return hosts;
    },
    async read(request) {
      if (!request.hostId.startsWith("node:") || !request.hostId.slice(5)) {
        throw new Error("Select a paired node host to read an OpenClaw session");
      }
      const nodeId = request.hostId.slice(5);
      const node = (await api.runtime.nodes.list()).nodes.find(
        (candidate) =>
          candidate.nodeId === nodeId && candidate.connected && isSessionHost(candidate),
      );
      if (!node) {
        throw new Error(
          "OpenClaw session node is unavailable. Reconnect it and refresh the catalog.",
        );
      }
      const commands = selectNodeCommands(node);
      if (request.profileRelation && !commands.catalog) {
        throw new Error(
          "This node does not support relationship filters. Update and approve the source commands, or choose All owners.",
        );
      }
      const raw = await api.runtime.nodes.invoke({
        nodeId,
        command: commands.read,
        timeoutMs: 30_000,
        scopes: ["operator.write"],
        params: {
          threadId: request.threadId,
          ...(request.profileRelation ? { profileRelation: request.profileRelation } : {}),
          limit: sessionCatalogPaging.boundedLimit(request.limit),
          ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
        },
      });
      const page = parseSessionShareTranscriptPage(raw, request.threadId);
      const linkParticipant = bindingFor(nodeId).linkGitHubIdentities
        ? (
            await prepareSessionCatalogGitHubLinker({
              participants: page.items.flatMap((item) => (item.sender ? [item.sender] : [])),
            })
          ).linkParticipant
        : undefined;
      return {
        ...page,
        hostId: request.hostId,
        label: nodeLabel(node),
        items: page.items.map((item) => {
          if (!item.sender) {
            return item;
          }
          const sender = {
            ...item.sender,
            identity: namespaceIdentity(item.sender.identity, request.hostId),
          };
          return Object.assign({}, item, { sender: linkParticipant?.(sender) ?? sender });
        }),
      };
    },
  };
}
