import {
  areDiagnosticsEnabledForProcess,
  createSubsystemLogger,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  publishSessionCatalogHost,
  sessionCatalogPaging,
  type SessionCatalogHost,
  type SessionCatalogProvider,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { createSessionCatalogGitHubLinker } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { sessionShareNodeBinding } from "./config.js";
import {
  SESSION_SHARE_COMMANDS,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
} from "./node-commands.js";
import { sessionShareOriginalUrl } from "./original-url.js";
import { parseSessionSharePage, parseSessionShareTranscriptPage } from "./wire.js";

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type GitHubLinker = ReturnType<typeof createSessionCatalogGitHubLinker>;
type CatalogIdentity = NonNullable<NonNullable<SessionCatalogSession["createdActor"]>["identity"]>;
type CatalogPage = ReturnType<typeof parseSessionSharePage>;
type NodePage = {
  nodeId: string;
  connection: CatalogNode["connectedAtMs"];
  page?: CatalogPage;
  pending?: Promise<CatalogPage>;
};

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

function observeCatalogPhase<T>(phase: "discovery" | "invoke", operation: () => Promise<T>) {
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
      if (elapsedMs < 1_000) {
        return;
      }
      const details = asOptionalRecord(asOptionalRecord(error)?.details);
      const nodeError = asOptionalRecord(details?.nodeError);
      const nodeErrorCode = nodeError?.code;
      log.warn("slow Session Share catalog phase", {
        phase,
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
    return operation().then(
      (value) => {
        finish("resolved");
        return value;
      },
      (error: unknown) => {
        finish("rejected", error);
        throw error;
      },
    );
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
  const pages = new Map<string, NodePage>();
  let connectedNodes = new Map<string, CatalogNode["connectedAtMs"]>();
  const active = new Set<Promise<CatalogPage>>();
  let config: ReturnType<PluginRuntime["config"]["current"]> | undefined;
  let invokeNode: OpenClawPluginServiceContext["invokeNode"];
  let lifetime = new AbortController();
  api.registerService({
    id: "session-share-catalog",
    start(ctx) {
      lifetime = new AbortController();
      invokeNode = ctx.invokeNode;
    },
    async stop() {
      invokeNode = undefined;
      lifetime.abort();
      pages.clear();
      connectedNodes.clear();
      await Promise.allSettled(active);
    },
  });
  const bindingFor = (nodeId: string) =>
    sessionShareNodeBinding(api.runtime.config.current(), nodeId);
  async function listNode(
    node: CatalogNode,
    query: Parameters<SessionCatalogProvider["list"]>[0],
    deadline: number,
  ): Promise<SessionCatalogHost> {
    const { onHost, waitUntil, signal: callerSignal } = query;
    const hostId = `node:${node.nodeId}`;
    const common = {
      hostId,
      label: nodeLabel(node),
      kind: "node" as const,
      nodeId: node.nodeId,
      connected: node.connected === true,
    };
    if (!node.connected) {
      return {
        ...common,
        sessions: [],
        error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
      };
    }
    const failed = (): SessionCatalogHost => ({
      ...common,
      sessions: [],
      error: {
        code: "NODE_INVOKE_FAILED",
        message:
          "Cannot list OpenClaw sessions. Check the paired node's session-share configuration and connection.",
      },
    });
    const project = (page: CatalogPage): SessionCatalogHost => {
      const binding = bindingFor(node.nodeId);
      const linker =
        binding.owner || binding.linkGitHubIdentities
          ? createSessionCatalogGitHubLinker()
          : undefined;
      const owner = binding.owner ? linker?.resolveOwner(binding.owner) : undefined;
      const linkParticipant = binding.linkGitHubIdentities ? linker?.linkParticipant : undefined;
      return {
        ...common,
        ...page,
        sessions: page.sessions.map((session) => ({
          ...bindSession(session, hostId, owner, linkParticipant),
          originalUrl: sessionShareOriginalUrl(binding.controlUiOrigin, session.threadId),
        })),
      };
    };
    try {
      query.signal?.throwIfAborted();
      const cursor = query.cursors?.[hostId];
      if (cursor !== undefined) {
        sessionCatalogPaging.decodeCursor(cursor);
      }
      const invokeListing = invokeNode;
      if (!invokeListing) {
        return failed();
      }
      const params = {
        limit: sessionCatalogPaging.boundedLimit(query.limitPerHost),
        ...(query.search ? { searchTerm: query.search } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      };
      const key = JSON.stringify([node.nodeId, params]);
      let entry = pages.get(key);
      if (!entry) {
        if (pages.size >= 32) {
          const evict = [...pages].find(([, candidate]) => !candidate.pending);
          if (evict) {
            pages.delete(evict[0]);
          }
        }
        entry = { nodeId: node.nodeId, connection: node.connectedAtMs };
        pages.set(key, entry);
      }
      const publication = entry;
      const revision = config;
      const signal = lifetime.signal;
      const current = () =>
        !signal.aborted &&
        api.runtime.config.current() === revision &&
        connectedNodes.has(node.nodeId) &&
        connectedNodes.get(node.nodeId) === publication.connection;
      const follower = Boolean(publication.pending);
      if (!publication.pending) {
        const pending = observeCatalogPhase("invoke", () =>
          invokeListing({
            nodeId: node.nodeId,
            command: SESSION_SHARE_LIST_COMMAND,
            params,
            timeoutMs: 30_000,
            signal,
          }),
        ).then((raw) => {
          const page = parseSessionSharePage(raw);
          if (current()) {
            publication.page = page;
          }
          return page;
        });
        publication.pending = pending;
        active.add(pending);
        const release = () => {
          publication.pending = undefined;
          active.delete(pending);
          // Bound retained pages without rejecting or retiring admitted source work.
          if (pages.size > 32 && pages.get(key) === publication) {
            pages.delete(key);
          }
        };
        void pending.then(release, release);
      }
      // Hydration borrows service authority, never a requesting connection's node handle.
      const completed = publication.pending.then(
        (page) => (current() ? project(page) : failed()),
        failed,
      );
      // Metadata lookups and pagination cannot consume pending host updates.
      if (query.allowPartialResults !== true || !onHost || !waitUntil) {
        return await completed;
      }
      const loading = (): SessionCatalogHost => {
        publishSessionCatalogHost(
          {
            waitUntil,
            onHost: (host) => {
              if (current() && !callerSignal?.aborted) {
                return onHost?.(host);
              }
            },
          },
          completed,
        );
        return {
          ...(publication.page ? project(publication.page) : { ...common, sessions: [] }),
          pending: true,
        };
      };
      const remaining = deadline - performance.now();
      if (follower || publication.page || remaining <= 0) {
        return loading();
      }
      return await withTimeout(completed, remaining, {
        message: "Session Share catalog is still loading",
      }).catch(loading);
    } catch {
      query.signal?.throwIfAborted();
      return failed();
    }
  }

  return {
    id: "openclaw",
    label: "OpenClaw sessions",
    supportsProcessHomeIsolation: true,
    audience: "session-viewers",
    async list(query) {
      const deadline = performance.now() + 5_000;
      query.signal?.throwIfAborted();
      const currentConfig = api.runtime.config.current();
      let nodes: CatalogNode[];
      try {
        nodes = (
          await observeCatalogPhase(
            "discovery",
            () => query.listNodes?.() ?? api.runtime.nodes.list(),
          )
        ).nodes;
      } catch {
        query.signal?.throwIfAborted();
        return [];
      }
      query.signal?.throwIfAborted();
      if (api.runtime.config.current() !== currentConfig) {
        return [];
      }
      if (config !== currentConfig) {
        config = currentConfig;
        pages.clear();
      }
      connectedNodes = new Map(
        nodes
          .filter((node) => node.connected && isSessionHost(node))
          .map((node) => [node.nodeId, node.connectedAtMs]),
      );
      for (const [key, entry] of pages) {
        if (
          !connectedNodes.has(entry.nodeId) ||
          connectedNodes.get(entry.nodeId) !== entry.connection
        ) {
          pages.delete(key);
        }
      }
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
        .slice(0, 32);
      const pending = eligible.map(async (node) => {
        const host = await listNode(node, query, deadline);
        query.signal?.throwIfAborted();
        if (!host.pending) {
          query.onHost?.(host);
        }
        return host;
      });
      let hosts: SessionCatalogHost[];
      try {
        hosts = await Promise.all(pending);
      } finally {
        // Keep every started invocation owned through retirement or publication failure.
        await Promise.allSettled(pending);
      }
      query.signal?.throwIfAborted();
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
      const linkParticipant = bindingFor(nodeId).linkGitHubIdentities
        ? createSessionCatalogGitHubLinker().linkParticipant
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
