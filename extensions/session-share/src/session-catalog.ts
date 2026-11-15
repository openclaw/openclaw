import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";
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
import type { SessionCatalogSourceProfileRelation } from "./wire.js";
import { parseSessionSharePage, parseSessionShareTranscriptPage } from "./wire.js";

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type GitHubLinker = Awaited<ReturnType<typeof prepareSessionCatalogGitHubLinker>>;
type CatalogIdentity = NonNullable<NonNullable<SessionCatalogSession["createdActor"]>["identity"]>;
type NodeSnapshot = {
  key: string;
  callerId?: string;
  pollId?: string;
  profileRelation?: SessionCatalogSourceProfileRelation;
  releaseCaller?: () => void;
  node: CatalogNode;
  config: ReturnType<PluginRuntime["config"]["current"]>;
  scope: PluginServiceSchedulerV1;
  sessions?: SessionCatalogSession[];
  publicationRevision: object;
  refreshedAt: number;
  consumedAt: number;
  retryMs: number;
  pending?: Promise<void>;
  error?: SessionCatalogHost["error"];
};

const REFRESH_MS = 30_000;
const MAX_STALENESS_MS = 60_000;
const REFRESH_BUDGET_MS = 300_000;
const MAX_SNAPSHOTS_PER_CALLER = 32;
const MAX_ADMITTED_SNAPSHOTS = 64;
const CONSUMER_IDLE_MS = 120_000;
const MAX_RETAINED_SNAPSHOTS = 32;
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
  const refreshes = createPermitPool(MAX_REFRESHES);
  const bindingFor = (nodeId: string) =>
    sessionShareNodeBinding(api.runtime.config.current(), nodeId);
  const current = (entry: NodeSnapshot) =>
    !entry.scope.signal.aborted &&
    api.runtime.config.current() === entry.config &&
    snapshots.get(entry.key) === entry;
  const retire = (entry: NodeSnapshot) => {
    if (snapshots.get(entry.key) === entry) {
      snapshots.delete(entry.key);
    }
    entry.releaseCaller?.();
    entry.sessions = undefined;
    void entry.scope.stop();
  };
  const sameConnection = (entry: NodeSnapshot, node: CatalogNode | undefined) =>
    node?.connected && isSessionHost(node) && node.connectedAtMs === entry.node.connectedAtMs;
  const retainRows = (entry: NodeSnapshot, rows: SessionCatalogSession[]) => {
    // Bound the shared row cache, not which connected callers may poll. Eviction
    // drops only settled cache bytes; it never stops another scope or in-flight IO.
    const retained = Array.from(snapshots.values()).filter(
      (candidate) => candidate !== entry && candidate.sessions !== undefined,
    );
    retained.sort((left, right) => left.refreshedAt - right.refreshedAt);
    while (retained.length >= MAX_RETAINED_SNAPSHOTS) {
      retained.shift()!.sessions = undefined;
    }
    entry.sessions = rows;
  };

  function refresh(entry: NodeSnapshot, owner: OpenClawPluginServiceContextV2) {
    if (performance.now() - entry.consumedAt >= CONSUMER_IDLE_MS) {
      retire(entry);
      return;
    }
    if (entry.pending) {
      return;
    }
    // Metadata from a previous source authorization is not a disclosure grant.
    entry.publicationRevision = {};
    entry.sessions = undefined;
    const completion = Promise.withResolvers<void>();
    entry.pending = completion.promise;
    const signal = entry.scope.signal;
    const release = () => completion.resolve();
    signal.addEventListener("abort", release, { once: true });
    const deadline = performance.now() + REFRESH_BUDGET_MS;
    const deadlineAtMs = Date.now() + REFRESH_BUDGET_MS;
    entry.scope.schedule({
      id: "refresh",
      delayMs: 0,
      async run() {
        const releasePermit = await refreshes.acquire({ signal, deadlineAtMs });
        try {
          if (!current(entry)) {
            return;
          }
          if (!releasePermit) {
            throw new Error("Session Share catalog refresh queue timed out");
          }
          const snapshot = await observeCatalogRefresh(
            async () => {
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
                    params: {
                      limit: 100,
                      ...(entry.profileRelation ? { profileRelation: entry.profileRelation } : {}),
                      ...(cursor ? { cursor } : {}),
                    },
                    timeoutMs,
                    signal,
                  }),
                  entry.profileRelation,
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
                  sessionCatalogPaging.decodeCursor(page.nextCursor, entry.profileRelation) <=
                    sessionCatalogPaging.decodeCursor(cursor, entry.profileRelation)
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
          retainRows(entry, snapshot);
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

  function reconcile(nodes: CatalogNode[], query?: Parameters<SessionCatalogProvider["list"]>[0]) {
    const owner = context;
    if (!owner || owner.scheduler.signal.aborted) {
      return;
    }
    const config = api.runtime.config.current();
    for (const entry of snapshots.values()) {
      // A caller's visible node inventory is not authoritative for another caller.
      const ownsScope =
        !query ||
        (entry.callerId === query.caller?.id &&
          entry.pollId === query.caller?.pollId &&
          JSON.stringify(entry.profileRelation) === JSON.stringify(query.profileRelation));
      if (
        entry.config !== config ||
        (!entry.pending && performance.now() - entry.consumedAt >= CONSUMER_IDLE_MS) ||
        (ownsScope &&
          !sameConnection(
            entry,
            nodes.find((node) => node.nodeId === entry.node.nodeId),
          ))
      ) {
        retire(entry);
      }
    }
  }

  const snapshotKey = (nodeId: string, query: Parameters<SessionCatalogProvider["list"]>[0]) =>
    JSON.stringify([
      nodeId,
      query.caller?.id ?? null,
      query.caller?.pollId ?? null,
      query.profileRelation ?? null,
    ]);

  function admit(nodes: CatalogNode[], query: Parameters<SessionCatalogProvider["list"]>[0]) {
    const owner = context;
    if (!owner || owner.scheduler.signal.aborted) {
      return;
    }
    const config = api.runtime.config.current();
    const selected = new Set(nodes.map((node) => node.nodeId));
    // The gateway's pre-await intent signal owns replacement, not arrival order here.
    query.caller?.pollSignal?.throwIfAborted();
    for (const node of nodes.filter((candidate) => candidate.connected)) {
      const key = snapshotKey(node.nodeId, query);
      const existing = snapshots.get(key);
      if (existing) {
        existing.consumedAt = performance.now();
        snapshots.delete(key);
        snapshots.set(key, existing);
        refresh(existing, owner);
        continue;
      }
      if (query.caller?.signal?.aborted || query.caller?.pollSignal?.aborted) {
        continue;
      }
      // Backpressure never cancels another caller's active work. FIFO permits and
      // the per-caller quota bound a cohort; unused consumers expire on reconciliation.
      // One connection cannot fill the global budget alone; at the shared cap,
      // new callers receive explicit capacity errors until a slot is released.
      const callerEntries = Array.from(snapshots.values()).filter(
        (entry) => entry.callerId === query.caller?.id,
      );
      if (callerEntries.length >= MAX_SNAPSHOTS_PER_CALLER) {
        const victim = callerEntries.find(
          (entry) =>
            !entry.pending &&
            entry.pollId === query.caller?.pollId &&
            JSON.stringify(entry.profileRelation) === JSON.stringify(query.profileRelation) &&
            !selected.has(entry.node.nodeId),
        );
        if (!victim) {
          continue;
        }
        retire(victim);
      }
      if (snapshots.size >= MAX_ADMITTED_SNAPSHOTS) {
        continue;
      }
      const entry: NodeSnapshot = {
        key,
        callerId: query.caller?.id,
        pollId: query.caller?.pollId,
        profileRelation: query.profileRelation && {
          relationship: query.profileRelation.relationship,
          target: { ...query.profileRelation.target },
        },
        node,
        config,
        scope: owner.scheduler.scope(),
        publicationRevision: {},
        refreshedAt: 0,
        consumedAt: performance.now(),
        retryMs: REFRESH_MS,
      };
      snapshots.set(key, entry);
      const callerSignals = [query.caller?.signal, query.caller?.pollSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const callerSignal = callerSignals.length ? AbortSignal.any(callerSignals) : undefined;
      if (callerSignal) {
        const close = () => retire(entry);
        callerSignal.addEventListener("abort", close, { once: true });
        entry.releaseCaller = () => callerSignal.removeEventListener("abort", close);
      }
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
      for (const entry of snapshots.values()) {
        retire(entry);
      }
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
    const entry = snapshots.get(snapshotKey(node.nodeId, query));
    const project = async (): Promise<SessionCatalogHost> => {
      if (!entry) {
        return failed(
          context ? "CATALOG_CAPACITY" : "NODE_INVOKE_FAILED",
          context
            ? "Shared catalog polling capacity is busy. Retry after unused polling scopes expire."
            : "Session Share is unavailable. Refresh the catalog.",
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
      const publicationRevision = entry.publicationRevision;
      const sessions = search
        ? entry.sessions.filter(
            (session) =>
              session.name?.toLowerCase().normalize("NFC").includes(search) ||
              session.threadId.toLowerCase().normalize("NFC").includes(search),
          )
        : entry.sessions;
      const offset = sessionCatalogPaging.decodeCursor(cursor, query.profileRelation);
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
      if (!current(entry) || entry.publicationRevision !== publicationRevision || signal?.aborted) {
        return failed("NODE_INVOKE_FAILED", "Session Share is unavailable. Refresh the catalog.");
      }
      const owner = binding.owner ? linker?.resolveOwner(binding.owner) : undefined;
      const linkParticipant = binding.linkGitHubIdentities ? linker?.linkParticipant : undefined;
      const host: SessionCatalogHost = {
        ...common,
        sessions: selected.map((session) => bindSession(session, hostId, owner, linkParticipant)),
        ...(offset + limit < sessions.length
          ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + limit, query.profileRelation) }
          : {}),
      };
      // Other hosts and identity linking may yield before aggregate publication.
      publicationGuards.set(host, () => {
        if (
          !current(entry) ||
          entry.publicationRevision !== publicationRevision ||
          signal?.aborted
        ) {
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
      query.caller?.pollSignal?.throwIfAborted();
      const config = api.runtime.config.current();
      let nodes: CatalogNode[];
      try {
        nodes = (await (query.listNodes?.() ?? api.runtime.nodes.list())).nodes;
      } catch {
        query.signal?.throwIfAborted();
        query.caller?.pollSignal?.throwIfAborted();
        if (api.runtime.config.current() !== config) {
          return [];
        }
        // Preserve a retryable discovery failure without exposing node-runtime details.
        throw new Error("Cannot discover OpenClaw session sources. Refresh the catalog to retry.");
      }
      query.signal?.throwIfAborted();
      query.caller?.pollSignal?.throwIfAborted();
      if (api.runtime.config.current() !== config) {
        return [];
      }
      reconcile(nodes, query);
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
        .slice(0, MAX_SNAPSHOTS_PER_CALLER);
      admit(eligible, query);
      const owner = context;
      const hosts = await Promise.all(
        eligible.map((node) => {
          query.signal?.throwIfAborted();
          query.caller?.pollSignal?.throwIfAborted();
          return listNode(node, query);
        }),
      );
      query.signal?.throwIfAborted();
      query.caller?.pollSignal?.throwIfAborted();
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
      const raw = await api.runtime.nodes.invoke({
        nodeId,
        command: SESSION_SHARE_READ_COMMAND,
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
