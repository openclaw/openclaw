import { memoryPrincipal, pinPrincipal, type VaultAccess } from "./access.js";
import { RECORD_MAX_BYTES } from "./limits.js";
import type {
  MemoryCitation,
  MemoryProviderRuntime,
  MemoryReference,
  MemorySearchRequest,
} from "./memory-provider-types.js";
import type { LoadedRecord } from "./model.js";
import { withinBudget } from "./response-budget.js";
import type { StoreRuntime } from "./store-runtime.js";
import type { Stores } from "./stores.js";
import { digest } from "./vault.js";
const revision = (r: Pick<LoadedRecord, "revision" | "hash">) => `${r.revision}:${r.hash}`;
// References carry their store: a reference from a former store never
// resolves against a coincidentally matching ID in another store.
const reference = (
  r: Pick<LoadedRecord, "id" | "revision" | "hash">,
  vaultId: string,
): MemoryReference => ({
  providerId: "knowledge",
  id: r.id,
  revision: `${revision(r)}@${vaultId}`,
});
const integer = (n: number | undefined, fallback: number, max: number) => {
  if (n === undefined) {
    return fallback;
  }
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`Expected an integer from 1 to ${max}.`);
  }
  return n;
};
const attribution = (origin?: string, who?: string) =>
  `Origin: ${origin || "not recorded"}; attribution: ${who || "not recorded"}.`;

/** Resolves every provider call through the same store resolution as native
 * tools, so an agent's provider and tools always share one store runtime. */
export function createKnowledgeMemoryRuntime(stores: Stores): MemoryProviderRuntime {
  let retiring = false;
  const generations = new Map<string, number>();
  return {
    async open({ agentId, context, purpose }) {
      // A lease keeps the principal and service incarnation it was opened with.
      // Grants load with the registry, so a cold lease waits for it before
      // pinning; otherwise a granted conversation would pin its own partition.
      const incarnation = stores.incarnation;
      await stores.ensure();
      stores.assertLive(incarnation);
      const pinned = pinPrincipal(
        memoryPrincipal(context, agentId, stores.policy.operatorRead, purpose, stores.grantFor),
      );
      // Host readiness leases may validate storage but never release its content.
      const assertContentAccess = () => {
        if (pinned.principal.healthOnly) {
          throw new Error(
            "Knowledge access unavailable: trusted agent/session authority is required.",
          );
        }
      };
      const principal = () => {
        pinned.assertSame();
        return pinned.principal;
      };
      const openedGeneration = generations.get(agentId) ?? 0;
      let closed = false;
      const lease = () => {
        stores.assertLive(incarnation);
        if (closed || retiring || (generations.get(agentId) ?? 0) !== openedGeneration) {
          throw new Error("Knowledge memory lease is closed or retiring.");
        }
      };
      // Each call re-resolves: an assignment change moves the next call, and a
      // call already bound to the former store fails its live checks.
      const run = async <T>(
        provision: boolean,
        operation: (runtime: StoreRuntime, access: VaultAccess) => Promise<T>,
        whenEmpty?: () => NoInfer<T>,
        content = true,
      ): Promise<T> => {
        lease();
        // Content access is decided by the lease, before any store resolution.
        if (content) {
          assertContentAccess();
        }
        // Operator inspection never creates storage; only an agent session's own use does.
        const opened = await stores.open(
          principal,
          { provision: provision && context.authority.kind === "session" },
          incarnation,
        );
        if (opened.kind !== "ready") {
          if (opened.kind === "unprovisioned" && whenEmpty) {
            return whenEmpty();
          }
          throw new Error(opened.message);
        }
        const guarded: VaultAccess = {
          ...opened.access,
          assertCurrent: () => {
            lease();
            opened.access.assertCurrent();
          },
        };
        return opened.runtime.enqueue(guarded.assertCurrent, async () => {
          const result = await operation(opened.runtime, guarded);
          guarded.assertCurrent();
          return result;
        });
      };
      return {
        provider: {
          capabilities: {
            sources: ["memory"],
            pagination: true,
            candidates: ["trigger", "project"],
            projectFilter: false,
          },
          search: (request: MemorySearchRequest) =>
            run(true, async ({ client: storage, vaultId }, guarded) => {
              if (request.sources && !request.sources.includes("memory")) {
                throw new Error(
                  "Knowledge does not search session transcripts; use conversation-history tools.",
                );
              }
              if (request.activeProjectKeys?.length) {
                throw new Error("Knowledge has no curated project-key selection capability.");
              }
              const limit = integer(request.maxResults, 20, 50);
              if (request.minScore !== undefined && !Number.isFinite(request.minScore)) {
                throw new Error("minScore must be finite.");
              }
              // Cursors bind to the store and partition; another store rejects them.
              const binding = digest(
                JSON.stringify([
                  vaultId,
                  guarded.scope,
                  request.query,
                  request.minScore ?? null,
                  request.sources ?? null,
                ]),
              );
              let offset = 0,
                snapshot: string | undefined;
              if (request.cursor !== undefined) {
                if (request.cursor.length > 1000) {
                  throw new Error("Invalid Knowledge search cursor.");
                }
                let cursor;
                try {
                  cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
                } catch {
                  throw new Error("Invalid Knowledge search cursor.");
                }
                if (
                  !cursor ||
                  cursor.binding !== binding ||
                  typeof cursor.snapshot !== "string" ||
                  !Number.isInteger(cursor.offset) ||
                  cursor.offset < 0 ||
                  cursor.offset > 500
                ) {
                  throw new Error("Invalid Knowledge search cursor.");
                }
                offset = cursor.offset;
                snapshot = cursor.snapshot;
              }
              const result = await storage.call("search", guarded, {
                query: request.query,
                offset,
                limit,
              });
              if (result.index.state !== "ready" || result.index.lag || !result.index.snapshot) {
                throw new Error(result.index.message);
              }
              if (snapshot && snapshot !== result.index.snapshot) {
                throw new Error("Knowledge search snapshot changed; restart without a cursor.");
              }
              const nextCursor =
                result.nextOffset === null
                  ? undefined
                  : Buffer.from(
                      JSON.stringify({
                        binding,
                        snapshot: result.index.snapshot,
                        offset: result.nextOffset,
                      }),
                    ).toString("base64url");
              const omittedSessions = request.sources?.includes("sessions");
              return {
                hits: result.hits
                  .filter(
                    (h) =>
                      request.minScore === undefined ||
                      (h.score !== null && h.score >= request.minScore),
                  )
                  .map((h) =>
                    Object.assign(
                      {
                        reference: reference(
                          { id: h.record.id, revision: h.citation.revision, hash: h.citation.hash },
                          vaultId,
                        ),
                        excerpt: `${h.record.title}\n${attribution(h.assertionOrigin, h.attribution)}\n${h.snippet.matchLocated === false ? "Opening excerpt (not the match location):\n" : ""}${h.snippet.text}`,
                      },
                      h.score === null ? {} : { score: h.score },
                      {
                        source: "memory" as const,
                        citations: [
                          {
                            label: `${h.record.title} (${h.citation.path})`,
                            reference: reference(h.citation, vaultId),
                          },
                        ],
                        // Evidence-backed is not synonymous with trusted automatic instruction/selection.
                        automaticRecall: { eligible: false as const },
                      },
                    ),
                  ),
                ...(nextCursor ? { nextCursor } : {}),
                coverage:
                  result.coverage.complete && !nextCursor && !omittedSessions
                    ? ("complete" as const)
                    : ("partial" as const),
                warning: `${result.coverage.message}${omittedSessions ? " Session transcripts were not searched." : ""}`,
              };
            }),
          get: (request) =>
            run(true, async ({ client: storage, vaultId }, guarded) => {
              if (
                request.reference.providerId !== "knowledge" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/.test(request.reference.id) ||
                request.reference.fragment !== undefined
              ) {
                throw new Error("Invalid Knowledge record reference.");
              }
              const [recordRevision, referenceStore] = request.reference.revision?.split("@") ?? [];
              if (request.reference.revision !== undefined && referenceStore !== vaultId) {
                throw new Error(
                  "This Knowledge reference belongs to a different store; search again.",
                );
              }
              const from = integer(request.from, 1, RECORD_MAX_BYTES + 3),
                count = integer(request.lines, 100, 200);
              const found = await storage.call("memoryGet", guarded, {
                id: request.reference.id,
                ...(recordRevision !== undefined ? { revision: recordRevision } : {}),
                from,
                count,
              });
              if (found.status !== "ok") {
                return { status: "not_found" as const };
              }
              const r = found.record,
                ref = reference(r, vaultId),
                nextFrom = from + found.lines;
              const citations: MemoryCitation[] = [
                { label: `${r.title} (${r.path})`, reference: ref },
                ...found.evidence.map((e) => ({
                  label: `${e.path} sha256:${e.sha256}${e.start_line ? ` lines ${e.start_line}–${e.end_line ?? e.start_line}` : ""}`,
                })),
              ];
              return {
                status: "ok" as const,
                reference: ref,
                text: found.text,
                citations,
                from,
                lines: found.lines,
                truncated: nextFrom <= found.total,
                ...(nextFrom <= found.total ? { nextFrom } : {}),
              };
            }),
          candidates: (request) =>
            run(
              false,
              async ({ client: storage, vaultId }, guarded) => {
                if (guarded.scope.visibility === "conversation") {
                  return {
                    hits: [],
                    coverage: "complete" as const,
                    warning: "Automatic recall uses only owner-approved private records.",
                  };
                }
                if (!pinned.principal.sessionPrivate) {
                  throw new Error(
                    "Automatic recall requires an owner-private memory audience or an owner read grant.",
                  );
                }
                if (request.kind !== "trigger" && request.kind !== "project") {
                  throw new Error("Knowledge candidates kind must be trigger or project.");
                }
                if (request.activeProjectKeys?.length) {
                  throw new Error("Knowledge relies on the host to apply project-key filtering.");
                }
                const limit = integer(request.limit, 48, 200);
                const candidates = await storage.call("memoryCandidates", guarded, {
                  kind: request.kind,
                  limit,
                });
                const result = {
                  hits: candidates.records.map((record) => ({
                    reference: reference(record, vaultId),
                    excerpt: record.recall.summary,
                    source: "memory",
                    // Citation framing is stable metadata; no unapproved title/path text enters the prompt.
                    citations: [
                      { label: `knowledge:${record.id}`, reference: reference(record, vaultId) },
                    ],
                    automaticRecall: {
                      eligible: true,
                      ...(record.recall.triggers?.length
                        ? { triggers: record.recall.triggers.join("\n") }
                        : {}),
                      ...(record.recall.importance !== undefined
                        ? { importance: record.recall.importance }
                        : {}),
                      ...(record.recall.projects?.length
                        ? { projectKeys: record.recall.projects }
                        : {}),
                    },
                  })),
                  coverage: candidates.complete ? ("complete" as const) : ("partial" as const),
                  warning:
                    "Approved private candidates only; partial coverage means validation issues, the requested limit or the response budget omitted candidates.",
                };
                // References/citations add framing absent from the worker result.
                while (!withinBudget(result) && result.hits.length) {
                  result.hits.pop();
                  result.coverage = "partial";
                }
                return result;
              },
              () => ({
                hits: [],
                coverage: "complete" as const,
                warning: "No approved private candidates in this unprovisioned store.",
              }),
            ),
          health: async () => {
            const healthOnly = pinned.principal.healthOnly;
            try {
              return await run(
                false,
                async ({ client: storage }, guarded) => {
                  const facts = await storage.call("memoryHealth", guarded);
                  const status = !facts.ontology
                    ? ("unavailable" as const)
                    : facts.issues
                      ? ("degraded" as const)
                      : ("ready" as const);
                  if (healthOnly) {
                    return { status, message: "Knowledge vault readiness check." };
                  }
                  return {
                    status,
                    message:
                      "Scoped vault validation; keyword index readiness is checked on search.",
                    details: {
                      records: facts.records,
                      issues: facts.issues,
                      retrieval: "keyword",
                      index: "checked-on-search",
                      scope: guarded.scope.visibility,
                    },
                  };
                },
                () =>
                  healthOnly
                    ? { status: "ready" as const, message: "Knowledge vault readiness check." }
                    : {
                        status: "ready" as const,
                        message: "This agent's store is created on first authorized use.",
                        details: {
                          records: 0,
                          issues: 0,
                          retrieval: "keyword",
                          index: "checked-on-search",
                          scope: "private" as const,
                        },
                      },
                false,
              );
            } catch (error) {
              if (!healthOnly) {
                throw error;
              }
              // Preserve caller/lifecycle fencing while withholding storage error details.
              lease();
              principal();
              return {
                status: "unavailable" as const,
                message: "Knowledge vault readiness unavailable.",
              };
            }
          },
          async close() {
            closed = true;
          },
        },
      };
    },
    prepareReload({ retireRuntime }) {
      if (retireRuntime) {
        retiring = true;
      }
      return {
        drain: () => stores.drainAll(),
        resume() {
          if (retireRuntime) {
            retiring = false;
          }
        },
      };
    },
    // Closing one agent's leases never disposes a store another agent uses.
    async closeMemorySearchManager({ agentId }) {
      generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
      const vaultId = stores.vaultFor(agentId);
      await (vaultId ? stores.running(vaultId)?.drain() : undefined);
    },
    async closeAllMemorySearchManagers() {
      for (const agentId of new Set([...generations.keys(), ...stores.agents()])) {
        generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
      }
      await stores.drainAll();
    },
  };
}
