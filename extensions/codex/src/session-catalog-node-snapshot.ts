import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AdoptedSessionEntry, nodeAdoptedSourceKey } from "./session-catalog-node-adoption.js";
import type { CatalogNode } from "./session-catalog-node-continue.js";
import type { CodexSessionCatalogHost } from "./session-catalog-types.js";

type NodeSnapshot = { key: string; host: CodexSessionCatalogHost };
type NodePublication = {
  connection: number | undefined;
  snapshot?: NodeSnapshot;
};

/** One query-compatible native page per node, owned by the registered catalog provider. */
export class CodexCatalogNodeSnapshots {
  private config: OpenClawConfig | undefined;
  private readonly nodes = new Map<string, NodePublication>();

  start(config: OpenClawConfig | undefined): void {
    if (this.config !== config) {
      this.nodes.clear();
      this.config = config;
    }
  }

  observe(nodes: readonly CatalogNode[]): void {
    const connected = new Map(
      nodes.filter((node) => node.connected).map((node) => [node.nodeId, node]),
    );
    for (const [nodeId, publication] of this.nodes) {
      const node = connected.get(nodeId);
      if (!node || node.connectedAtMs !== publication.connection) {
        this.nodes.delete(nodeId);
      }
    }
    for (const node of connected.values()) {
      if (!this.nodes.has(node.nodeId)) {
        this.nodes.set(node.nodeId, { connection: node.connectedAtMs });
      }
    }
  }

  forNode(node: CatalogNode, key: string) {
    let publication = this.nodes.get(node.nodeId);
    if (!publication) {
      publication = { connection: node.connectedAtMs };
      this.nodes.set(node.nodeId, publication);
    }
    return {
      read: () => (publication.snapshot?.key === key ? publication.snapshot : undefined),
      publish: (host: CodexSessionCatalogHost) => {
        publication.snapshot = node.connected && host.connected ? { key, host } : undefined;
      },
    };
  }
}

export function createNodeHostPublication(
  publication: ReturnType<CodexCatalogNodeSnapshots["forNode"]>,
  adopted: ReadonlyMap<string, AdoptedSessionEntry>,
  sourceKey: typeof nodeAdoptedSourceKey,
  onHost: ((host: CodexSessionCatalogHost) => void) | undefined,
  signal: AbortSignal | undefined,
  partial: boolean,
  waitUntil: ((completion: Promise<void>) => void) | undefined,
) {
  let publishedSnapshot: NodeSnapshot | undefined;
  let publishedHost: CodexSessionCatalogHost | undefined;
  // Late callbacks retain prepared adoption facts, never the request's entries or node inventory.
  const project = (host: CodexSessionCatalogHost): CodexSessionCatalogHost => ({
    ...host,
    sessions: host.sessions.map((session) => {
      const entry = session.sourceHomeId
        ? adopted.get(sourceKey(host.hostId, session.threadId, session.sourceHomeId))
        : undefined;
      return entry ? { ...session, sessionKey: entry.key } : session;
    }),
  });
  const emit = (host: CodexSessionCatalogHost) => {
    publishedHost = project(host);
    return onHost?.(publishedHost);
  };
  return {
    project,
    readPublished: () => publishedHost,
    publish: (host: CodexSessionCatalogHost) => {
      if (signal?.aborted) {
        // Complete callers still own cancellation callbacks; never retain their failed result.
        return partial ? undefined : onHost?.(project(host));
      }
      publication.publish(host);
      publishedSnapshot = publication.read();
      return emit(host);
    },
    publishCached: (snapshot: NodeSnapshot) => {
      if (signal?.aborted || snapshot === publishedSnapshot) {
        return;
      }
      const completion = createDeferred<void>();
      void completion.promise.catch(() => undefined);
      try {
        waitUntil?.(completion.promise);
        // Keep replay atomic with the final array; a deferred older frame could overwrite it.
        completion.resolve(emit(snapshot.host));
        publishedSnapshot = snapshot;
      } catch (error) {
        completion.reject(error);
        throw error;
      }
    },
  };
}
