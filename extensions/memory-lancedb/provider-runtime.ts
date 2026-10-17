import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { MemoryConfig } from "./config.js";
import { type Embeddings, MemoryRecallEmbeddingError } from "./embeddings.js";
import type { MemoryDB } from "./lancedb-store.js";
import { cleanMemorySearchResults, normalizeRecallQuery } from "./memory-policy.js";
import { startMemoryRecall } from "./recall-service.js";

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type MemoryProviderOpenParams = Parameters<MemoryProviderRuntime["open"]>[0];
type MemoryProviderHandle = NonNullable<
  Awaited<ReturnType<MemoryProviderRuntime["open"]>>["provider"]
>;
type MemoryCallerAuthority = MemoryProviderOpenParams["context"]["authority"];
type MemoryHealth = Awaited<ReturnType<MemoryProviderHandle["health"]>>;
type MemorySearchHit = Awaited<ReturnType<MemoryProviderHandle["search"]>>["hits"][number];

const PROVIDER_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_PROVIDER_SEARCH_RESULTS = 5;
const MAX_PROVIDER_SEARCH_RESULTS = 50;
// Matches memory_recall: filtered rows must not starve the requested page.
const PROVIDER_SEARCH_OVERFETCH_EXTRA = 10;
const DEFAULT_PROVIDER_MIN_SCORE = 0.1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the time is kept: provider error text can name host paths and health reaches every caller.
type EmbeddingFailure = { atMs: number };

/** Records the latest embedding outcome per agent so health never spends a provider call. */
export function createEmbeddingHealthTracker<T extends Embeddings>(inner: T) {
  const failures = new Map<string, EmbeddingFailure>();
  const embeddings: T = {
    ...inner,
    async embed(agentId, text, embeddingConfig, timeoutMs) {
      try {
        const vector = await inner.embed(agentId, text, embeddingConfig, timeoutMs);
        failures.delete(agentId);
        return vector;
      } catch (error) {
        failures.set(agentId, { atMs: Date.now() });
        throw error;
      }
    },
  };
  return {
    embeddings,
    lastFailure: (agentId: string): EmbeddingFailure | undefined => failures.get(agentId),
  };
}

export type LanceDbMemoryProviderDeps = {
  providerId: string;
  db: Pick<MemoryDB, "search" | "query">;
  embeddings: Pick<Embeddings, "embed">;
  resolveCurrentConfig(): MemoryConfig;
  /** Returns the normalized agent id only while memory is enabled for that agent. */
  resolveEnabledAgentId(rawAgentId: string | undefined, cfg: OpenClawConfig): string | undefined;
  /** Counts one agent's stored memories without creating or mutating the table. */
  countMemories(agentId: string): Promise<number>;
  lastEmbeddingFailure(agentId: string): EmbeddingFailure | undefined;
  readRecallCooldown(agentId: string): { error: string } | undefined;
  recordRecallCooldown(agentId: string, error: string): void;
  isRecallTimeoutError(error: unknown): boolean;
  logger: { warn?: (message: string) => void };
};

/**
 * Stored memories belong to the agent owner. Operators act for the opened agent; a session
 * reads them only under a host-minted owner-private audience for that same agent.
 */
function resolveReadDenial(authority: MemoryCallerAuthority, agentId: string): string | undefined {
  if (authority.kind === "operator") {
    return undefined;
  }
  if (authority.kind === "host") {
    return "host operations cannot read stored memories";
  }
  const audience = authority.audience;
  if (audience?.kind !== "owner-private") {
    return "this session has no owner-private memory audience";
  }
  if (normalizeAgentId(audience.agentId) !== agentId) {
    return "the memory audience belongs to another agent";
  }
  return undefined;
}

function sliceLines(text: string, from: number | undefined, lines: number | undefined) {
  const all = text.split("\n");
  const start = Math.max(1, Math.floor(from ?? 1));
  const count = lines === undefined ? all.length : Math.max(1, Math.floor(lines));
  const selected = all.slice(start - 1, start - 1 + count);
  const end = start - 1 + selected.length;
  const truncated = end < all.length;
  return {
    text: selected.join("\n"),
    from: start,
    lines: selected.length,
    truncated,
    ...(truncated ? { nextFrom: end + 1 } : {}),
  };
}

/** Neutral host read access to the plugin's own store; its tools and hooks keep their paths. */
export function createLanceDbMemoryProviderRuntime(
  deps: LanceDbMemoryProviderDeps,
): MemoryProviderRuntime {
  return {
    async open(params: MemoryProviderOpenParams) {
      const agentId = deps.resolveEnabledAgentId(params.agentId, params.cfg);
      if (!agentId) {
        return { provider: null, error: "Memory is disabled for this agent." };
      }
      const { context } = params;
      const readDenial = resolveReadDenial(context.authority, agentId);
      const assertCurrent = () => {
        context.assertCurrent();
        context.signal?.throwIfAborted();
      };
      const assertReadAllowed = () => {
        if (readDenial) {
          throw new Error(`memory-lancedb: memory access denied: ${readDenial}`);
        }
        assertCurrent();
      };
      const reference = (id: string) => ({ providerId: deps.providerId, id });

      const provider: MemoryProviderHandle = {
        capabilities: {
          sources: ["memory"],
          pagination: false,
          candidates: [],
          projectFilter: false,
        },
        async search(request) {
          if (readDenial) {
            // Like a legacy owner filtering every hit: consumers that search for any
            // session (Memory Wiki, voice context) get no rows and no failure.
            assertCurrent();
            return {
              hits: [],
              warning: `memory-lancedb: stored memories were not searched: ${readDenial}`,
            };
          }
          assertCurrent();
          const query = request.query.trim();
          if (!query) {
            return { hits: [], coverage: "complete" };
          }
          const cooldown = deps.readRecallCooldown(agentId);
          if (cooldown) {
            throw new Error(`memory-lancedb: memory search is unavailable: ${cooldown.error}`);
          }
          const currentCfg = deps.resolveCurrentConfig();
          const recallMaxChars = currentCfg.recallMaxChars;
          const maxResults = Math.min(
            MAX_PROVIDER_SEARCH_RESULTS,
            Math.max(1, Math.floor(request.maxResults ?? DEFAULT_PROVIDER_SEARCH_RESULTS)),
          );
          const minScore = request.minScore ?? DEFAULT_PROVIDER_MIN_SCORE;
          const recallOperation = startMemoryRecall({
            timeoutMs: PROVIDER_SEARCH_TIMEOUT_MS,
            embed: (timeoutMs) =>
              deps.embeddings.embed(
                agentId,
                normalizeRecallQuery(query, recallMaxChars),
                currentCfg.embedding,
                timeoutMs(),
              ),
            // Authority may lapse while the query embeds or while the store prepares its
            // table; never dispatch a read under a stale grant.
            beforeSearch: assertReadAllowed,
            search: (vector, timeoutMs) =>
              deps.db.search(
                agentId,
                vector,
                maxResults + PROVIDER_SEARCH_OVERFETCH_EXTRA,
                minScore,
                { timeoutMs, beforeRead: assertReadAllowed },
              ),
          });
          let recall: Awaited<typeof recallOperation.result>;
          try {
            recall = await recallOperation.result;
          } catch (error) {
            if (!(error instanceof MemoryRecallEmbeddingError)) {
              throw error;
            }
            const message = formatErrorMessage(error.originalError);
            deps.logger.warn?.(`memory-lancedb: memory search embedding failed: ${message}`);
            if (deps.isRecallTimeoutError(error.originalError)) {
              deps.recordRecallCooldown(agentId, message);
            }
            throw new Error(`memory-lancedb: memory search embedding failed: ${message}`, {
              cause: error,
            });
          }
          if (recall.status === "timeout") {
            const message = `memory search timed out after ${Math.round(PROVIDER_SEARCH_TIMEOUT_MS / 1000)}s`;
            if (recallOperation.phase === "embedding") {
              deps.recordRecallCooldown(agentId, message);
            }
            throw new Error(`memory-lancedb: ${message}`);
          }
          assertCurrent();
          const hits = cleanMemorySearchResults(recall.value)
            .slice(0, maxResults)
            .map(({ entry, score }): MemorySearchHit => {
              const ref = reference(entry.id);
              return {
                reference: ref,
                excerpt: truncateUtf16Safe(entry.text, recallMaxChars),
                score,
                source: "memory",
                citations: [{ label: `memory-lancedb:${entry.id}`, reference: ref }],
              };
            });
          return { hits, coverage: "complete" };
        },
        async get(request) {
          assertReadAllowed();
          const { id, revision } = request.reference;
          // Rows carry no revisions; a revisioned reference cannot name current content.
          if (revision !== undefined || !UUID_PATTERN.test(id)) {
            return { status: "not_found" };
          }
          const rows = await deps.db.query(agentId, {
            columns: ["id", "text"],
            filter: { column: "id", operator: "=", value: id },
            limit: 1,
            beforeRead: assertReadAllowed,
          });
          assertCurrent();
          const text = rows[0]?.text;
          if (typeof text !== "string") {
            return { status: "not_found" };
          }
          const ref = reference(id);
          return {
            status: "ok",
            reference: ref,
            citations: [{ label: `memory-lancedb:${id}`, reference: ref }],
            ...sliceLines(text, request.from, request.lines),
          };
        },
        async health(): Promise<MemoryHealth> {
          assertCurrent();
          const { embedding, autoCapture, autoRecall } = deps.resolveCurrentConfig();
          // Health reaches every authenticated caller: no memory text, no host paths.
          const details: Record<string, unknown> = {
            backend: "lancedb",
            embedding: {
              provider: embedding.provider,
              model: embedding.model,
              ...(embedding.dimensions === undefined ? {} : { dimensions: embedding.dimensions }),
            },
            autoCapture,
            autoRecall,
          };
          let memories: number;
          try {
            memories = await deps.countMemories(agentId);
          } catch (error) {
            deps.logger.warn?.(
              `memory-lancedb: health could not read the memory store: ${formatErrorMessage(error)}`,
            );
            return {
              status: "unavailable",
              message: "The LanceDB memory store could not be read. Check the Gateway log.",
              details,
            };
          }
          if (!readDenial) {
            details.memories = memories;
          }
          const cooldown = deps.readRecallCooldown(agentId);
          const failure = deps.lastEmbeddingFailure(agentId);
          if (cooldown || failure) {
            return {
              status: "degraded",
              message:
                "The last memory embedding request failed. Check the Gateway log. If credential resolution failed, run openclaw secrets reload, then retry memory search.",
              details: failure ? { ...details, embeddingFailedAtMs: failure.atMs } : details,
            };
          }
          return { status: "ready", details };
        },
        // The store and embedding clients are shared with the plugin's tools and hooks.
        async close() {},
      };
      return { provider };
    },
  };
}
