import {
  areDiagnosticsEnabledForProcess,
  createSubsystemLogger,
} from "openclaw/plugin-sdk/diagnostic-runtime";
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
} from "openclaw/plugin-sdk/session-catalog";
import { prepareSessionCatalogGitHubLinker } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sessionShareNodeBinding } from "./config.js";
import {
  SESSION_SHARE_COMMANDS,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
} from "./node-commands.js";
import { parseSessionSharePage, parseSessionShareTranscriptPage } from "./wire.js";

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type GitHubLinker = Awaited<ReturnType<typeof prepareSessionCatalogGitHubLinker>>;
type CatalogIdentity = NonNullable<NonNullable<SessionCatalogSession["createdActor"]>["identity"]>;
type NodeSnapshot = {
  node: CatalogNode;
  config: ReturnType<PluginRuntime["config"]["current"]>;
  scope: PluginServiceSchedulerV1;
  sessions?: SessionCatalogSession[];
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

const log = createSubsystemLogger("gateway/session-catalog");
const nodeErrorCodes = new Set([
  "TIMEOUT",
  "NOT_CONNECTED",
  "PAIRING_CHANGED",
  "ROUTE_CHANGED",
  "ABORTED",
  "UNAVAILABLE",
  "POLICY_CHANGED",
  "APPROVAL_AUTHORITY_CLOSED",
]);

async function observeCatalogRefresh<T>(operation: () => Promise<T>, warn: () => boolean) {
  if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn")) {
    return operation();
  }
  const started = performance.now();
  const finish = (outcome: "resolved" | "rejected", error?: unknown) => {
    try {
      if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn")) {
        return;
      }
      const elapsedMs = performance.now() - started;
      if (elapsedMs < 1_000 || !warn()) {
        return;
      }
      const details = asOptionalRecord(asOptionalRecord(error)?.details);
      const nodeError = asOptionalRecord(details?.nodeError);
      const nodeErrorCode = nodeError?.code;
      log.warn("slow Session Share catalog refresh", {
        elapsedMs: Math.round(elapsedMs),
        outcome,
        ...(nodeError
          ? {
              nodeErrorCode:
                typeof nodeErrorCode === "string" && nodeErrorCodes.has(nodeErrorCode)
                  ? nodeErrorCode
                  : "unknown",
            }
          : {}),
        ...(typeof details?.nodeCommandDispatched === "boolean"
          ? { nodeCommandDispatched: details.nodeCommandDispatched }
          : {}),
      });
    } catch {
      // A diagnostic sink must not replace the catalog result or error.
    }
  };
  try {
    const value = await operation();
    finish("resolved");
    return value;
  } catch (error) {
    finish("rejected", error);
    throw error;
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
  return SESSION_SHARE_COMMANDS.every((command) => node.commands?.includes(command));
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
  const workers = new Set<number>();
  const queued = new Map<NodeSnapshot, () => Promise<void>>();
  const bindingFor = (nodeId: string) =>
    sessionShareNodeBinding(api.runtime.config.current(), nodeId);
  const current = (entry: NodeSnapshot) =>
    !entry.scope.signal.aborted &&
    api.runtime.config.current() === entry.config &&
    snapshots.get(entry.node.nodeId) === entry;
  const retire = (entry: NodeSnapshot) => {
    snapshots.delete(entry.node.nodeId);
    entry.sessions = undefined;
    void entry.scope.stop();
  };
  const sameConnection = (entry: NodeSnapshot, node: CatalogNode | undefined) =>
    node?.connected && isSessionHost(node) && node.connectedAtMs === entry.node.connectedAtMs;

  function pump(owner: OpenClawPluginServiceContextV2) {
    if (context !== owner || owner.scheduler.signal.aborted) {
      return;
    }
    for (let worker = 0; worker < MAX_REFRESHES; worker++) {
      if (workers.has(worker) || !queued.size) {
        continue;
      }
      workers.add(worker);
      owner.scheduler.schedule({
        id: `refresh:${worker}`,
        delayMs: 0,
        async run() {
          try {
            for (;;) {
              const next = queued.entries().next().value;
              if (!next) {
                return;
              }
              const [entry, run] = next;
              queued.delete(entry);
              if (current(entry)) {
                await run();
              } else {
                retire(entry);
              }
            }
          } finally {
            workers.delete(worker);
            pump(owner);
          }
        },
      });
    }
  }

  function refresh(entry: NodeSnapshot, owner: OpenClawPluginServiceContextV2) {
    const completion = Promise.withResolvers<void>();
    entry.pending = completion.promise;
    const signal = entry.scope.signal;
    const release = () => {
      queued.delete(entry);
      completion.resolve();
    };
    signal.addEventListener("abort", release, { once: true });
    queued.set(entry, async () => {
      try {
        const snapshot = await observeCatalogRefresh(
          async () => {
            const deadline = performance.now() + REFRESH_BUDGET_MS;
            const sessions: SessionCatalogSession[] = [];
            let cursor: string | undefined;
            let bytes = 0;
            do {
              if (!current(entry) || !owner.invokeNode) {
                throw new Error("Session Share catalog owner retired");
              }
              const timeoutMs = Math.min(REFRESH_MS, Math.ceil(deadline - performance.now()));
              if (timeoutMs <= 0) {
                throw new Error("Session Share catalog refresh timed out");
              }
              const page = parseSessionSharePage(
                await owner.invokeNode({
                  nodeId: entry.node.nodeId,
                  command: SESSION_SHARE_LIST_COMMAND,
                  params: { limit: 100, ...(cursor ? { cursor } : {}) },
                  timeoutMs,
                  signal,
                }),
              );
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
                sessionCatalogPaging.decodeCursor(page.nextCursor) <=
                  sessionCatalogPaging.decodeCursor(cursor)
              ) {
                throw new Error("Session Share catalog cursor did not advance");
              }
              cursor = page.nextCursor;
            } while (cursor);
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
        entry.error = undefined;
      } catch (error) {
        entry.retryMs = entry.error ? Math.min(entry.retryMs * 2, 300_000) : REFRESH_MS;
        entry.error =
          error instanceof SnapshotLimitError
            ? { code: "CATALOG_TOO_LARGE", message: error.message }
            : {
                code: "NODE_INVOKE_FAILED",
                message:
                  "Cannot refresh OpenClaw sessions. Check the paired node's session-share configuration and connection.",
              };
      } finally {
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
    });
    pump(owner);
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

  function admit(nodes: CatalogNode[]) {
    const owner = context;
    if (!owner || owner.scheduler.signal.aborted) {
      return;
    }
    const config = api.runtime.config.current();
    const selected = new Set(nodes.map((node) => node.nodeId));
    for (const node of nodes.filter((candidate) => candidate.connected)) {
      const existing = snapshots.get(node.nodeId);
      if (existing) {
        snapshots.delete(node.nodeId);
        snapshots.set(node.nodeId, existing);
        continue;
      }
      if (snapshots.size >= MAX_SNAPSHOTS) {
        const victim = Array.from(snapshots.values()).find(
          (candidate) => !candidate.pending && !selected.has(candidate.node.nodeId),
        );
        if (!victim) {
          continue;
        }
        retire(victim);
      }
      const entry: NodeSnapshot = {
        node,
        config,
        scope: owner.scheduler.scope(),
        refreshedAt: 0,
        retryMs: REFRESH_MS,
      };
      snapshots.set(node.nodeId, entry);
      refresh(entry, owner);
    }
  }

  api.registerService({
    id: "session-share-catalog",
    apiVersion: 2,
    start(ctx) {
      // The host joins the previous scheduler before starting a new service generation.
      workers.clear();
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
      queued.clear();
    },
  });

  async function listNode(
    node: CatalogNode,
    query: Parameters<SessionCatalogProvider["list"]>[0],
  ): Promise<SessionCatalogHost> {
    const hostId = `node:${node.nodeId}`;
    const { onHost, waitUntil, signal, allowPartialResults } = query;
    const search = query.search?.trim().toLowerCase();
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
    const entry = snapshots.get(node.nodeId);
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
      const sessions = search
        ? entry.sessions.filter(
            (session) =>
              session.name?.toLowerCase().includes(search) ||
              session.threadId.toLowerCase().includes(search),
          )
        : entry.sessions;
      const offset = sessionCatalogPaging.decodeCursor(cursor);
      const binding = bindingFor(node.nodeId);
      const selected = sessions.slice(offset, offset + limit);
      const linker =
        binding.owner || binding.linkGitHubIdentities
          ? await prepareSessionCatalogGitHubLinker({
              owners: binding.owner ? [binding.owner] : [],
              participants: binding.linkGitHubIdentities
                ? selected.flatMap(({ createdActor }) =>
                    createdActor?.identity ? [{ identity: createdActor.identity }] : [],
                  )
                : [],
            })
          : undefined;
      if (!current(entry) || signal?.aborted) {
        return failed("NODE_INVOKE_FAILED", "Session Share is unavailable. Refresh the catalog.");
      }
      const owner = binding.owner ? linker?.resolveOwner(binding.owner) : undefined;
      const linkParticipant = binding.linkGitHubIdentities ? linker?.linkParticipant : undefined;
      const host: SessionCatalogHost = {
        ...common,
        sessions: selected.map((session) => bindSession(session, hostId, owner, linkParticipant)),
        ...(offset + limit < sessions.length
          ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + limit) }
          : {}),
      };
      publicationGuards.set(host, () => {
        if (!current(entry) || signal?.aborted) {
          throw new Error("Session Share is unavailable. Refresh the catalog.");
        }
        linker?.assertCurrent();
      });
      return host;
    };
    const host = await project();
    if ((entry && !current(entry)) || signal?.aborted) {
      return failed("NODE_INVOKE_FAILED", "Session Share is unavailable. Refresh the catalog.");
    }
    publicationGuards.get(host)?.();
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
      if (!host.error) {
        const pendingHost = { ...host, pending: true };
        const guard = publicationGuards.get(host);
        if (guard) {
          publicationGuards.set(pendingHost, guard);
        }
        return pendingHost;
      }
    }
    onHost?.(host);
    return host;
  }

  return {
    id: "openclaw",
    label: "OpenClaw sessions",
    supportsProcessHomeIsolation: true,
    audience: "session-viewers",
    async list(query) {
      query.signal?.throwIfAborted();
      const config = api.runtime.config.current();
      let nodes: CatalogNode[];
      try {
        nodes = (await (query.listNodes?.() ?? api.runtime.nodes.list())).nodes;
      } catch {
        query.signal?.throwIfAborted();
        return [];
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
      admit(eligible);
      const owner = context;
      const hosts = await Promise.all(
        eligible.map((node) => {
          query.signal?.throwIfAborted();
          return listNode(node, query);
        }),
      );
      query.signal?.throwIfAborted();
      if (context !== owner || api.runtime.config.current() !== config) {
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
      const raw = await api.runtime.nodes.invoke({
        nodeId,
        command: SESSION_SHARE_READ_COMMAND,
        timeoutMs: 30_000,
        scopes: ["operator.write"],
        params: {
          threadId: request.threadId,
          limit: sessionCatalogPaging.boundedLimit(request.limit),
          ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
        },
      });
      const page = parseSessionShareTranscriptPage(raw, request.threadId);
      const config = api.runtime.config.current();
      const linkParticipant = bindingFor(nodeId).linkGitHubIdentities
        ? (
            await prepareSessionCatalogGitHubLinker({
              participants: page.items.flatMap((item) => (item.sender ? [item.sender] : [])),
            })
          ).linkParticipant
        : undefined;
      if (api.runtime.config.current() !== config) {
        throw new Error(
          "Session Share configuration changed while preparing the page. Retry the request.",
        );
      }
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
