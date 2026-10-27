import type { MessagePort } from "node:worker_threads";
import type { VaultAccess } from "./access.js";
import { catalogFacts } from "./catalog.js";
import { inspectRecord, inspectOntology } from "./inspection.js";
import { mergeCandidates as findMergeCandidates } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import type { Receipt } from "./mutation-contract.js";
import type { StoreConfig } from "./real-vault.js";
import { withinBudget } from "./response-budget.js";
import { eligible } from "./retrieval.js";
import { AUTHORITY_REVOKED, type HostMessage, type WorkerMessage } from "./storage-protocol.js";
import { PageBudgetError } from "./storage-types.js";
import { KnowledgeStorage } from "./storage.js";

type Storage = KnowledgeStorage;
type Access = VaultAccess;
// Structured-clone boundary: operation inputs arrive as plain JSON values.
type In<T> = T extends (input: infer I, ...rest: never[]) => unknown ? I : never;

const revision = (r: Pick<LoadedRecord, "revision" | "hash">) => `${r.revision}:${r.hash}`;
// Operations that write page prose return a page-budget rejection as their receipt.
const budgeted = async (work: Promise<Receipt>) => {
  try {
    return await work;
  } catch (error) {
    if (error instanceof PageBudgetError) {
      return error.receipt;
    }
    throw error;
  }
};
const attribution = (origin?: string, who?: string) =>
  `Origin: ${origin || "not recorded"}; attribution: ${who || "not recorded"}.`;

/** Every storage operation the main thread may request, by name. Each runs
 * entirely in the worker; `access.assertCurrent` calls back to the main thread. */
export const operations = {
  sessionActivity: (s: Storage, a: Access, input: import("./session-activity.js").ActivityInput) =>
    s.sessionActivity(input, a),
  verify: (s: Storage, a: Access, input: In<Storage["verify"]>) => s.verify(input, a),
  sourceCheck: (s: Storage, a: Access, input: In<Storage["sourceCheck"]>) =>
    s.sourceCheck(input, a),
  batch: (s: Storage, a: Access, input: In<Storage["batch"]>) =>
    budgeted(s.batch(input, a, "agent")),
  editBody: (s: Storage, a: Access, input: In<Storage["editBody"]>) =>
    budgeted(s.editBody(input, a)),
  extractSection: (s: Storage, a: Access, input: In<Storage["extractSection"]>) =>
    budgeted(s.extractSection(input, a)),
  reconcileEvidence: (s: Storage, a: Access, input: In<Storage["reconcileEvidence"]>) =>
    s.reconcileEvidence(input, a),
  annotate: (s: Storage, a: Access, input: In<Storage["annotate"]>) =>
    s.annotate(input, a, "agent"),
  timeline: (s: Storage, a: Access, input: In<Storage["timeline"]>) => s.timeline(input, a),
  chronicleDay: (s: Storage, a: Access, input: In<Storage["chronicleDay"]>) =>
    s.chronicleDay(input, a),
  chronicleSince: (s: Storage, a: Access, input: In<Storage["chronicleSince"]>) =>
    s.chronicleSince(input, a),
  chronicleLastSeen: (s: Storage, a: Access, input: In<Storage["chronicleLastSeen"]>) =>
    s.chronicleLastSeen(input, a),
  recent: (s: Storage, a: Access, input: In<Storage["recent"]>) => s.recent(input, a),
  attach: (s: Storage, a: Access, input: In<Storage["attach"]>) => s.attach(input, a),
  save: (s: Storage, a: Access, input: { value: In<Storage["save"]>; actor: string }) =>
    budgeted(s.save(input.value, a, input.actor)),
  createClaim: (
    s: Storage,
    a: Access,
    input: { value: In<Storage["createClaim"]>; actor: string },
  ) => s.createClaim(input.value, a, input.actor),
  createRelationship: (
    s: Storage,
    a: Access,
    input: { value: In<Storage["createRelationship"]>; actor: string },
  ) => s.createRelationship(input.value, a, input.actor),
  remember: (s: Storage, a: Access, input: In<Storage["remember"]>) =>
    s.remember(input, a, "agent"),
  relink: (s: Storage, a: Access, input: In<Storage["relink"]>) => s.relink(input, a, "agent"),
  partitions: (s: Storage) => s.partitions(),
  maintenanceRelink: (s: Storage, a: Access, input: In<Storage["relink"]>) =>
    s.relink(input, a, "maintenance"),
  correct: (s: Storage, a: Access, input: In<Storage["correct"]>) => s.correct(input, a, "agent"),
  withdraw: (s: Storage, a: Access, input: In<Storage["withdraw"]>) =>
    s.withdraw(input, a, "agent"),
  merge: (s: Storage, a: Access, input: In<Storage["merge"]>) =>
    budgeted(s.merge(input, a, "agent")),
  unmerge: (s: Storage, a: Access, input: In<Storage["unmerge"]>) => s.unmerge(input, a, "agent"),
  recall: (s: Storage, a: Access, input: In<Storage["recall"]>) => s.recall(input, a, "agent"),
  connections: (s: Storage, a: Access, input: In<Storage["connections"]>) =>
    s.connections(input, a),
  resume: (s: Storage, a: Access, input: { requestId: string }) => s.resume(a, input.requestId),
  revision: (
    s: Storage,
    a: Access,
    input: { sequence: number; offset?: number; maxChars?: number },
  ) => s.revision(a, input.sequence, input),
  mutation: (
    s: Storage,
    a: Access,
    input: Parameters<Storage["mutation"]>[2] & { requestId: string },
  ) => s.mutation(a, input.requestId, input),
  history: async (s: Storage, a: Access, input: Parameters<Storage["history"]>[1]) => {
    await s.initialize(a);
    return s.history(a, input);
  },
  search: (s: Storage, a: Access, input: In<Storage["search"]>) => s.search(input, a),
  lookup: (s: Storage, a: Access, input: In<Storage["lookup"]>) => s.lookup(input, a),
  evidenceRead: (
    s: Storage,
    a: Access,
    input: import("./evidence-read-contract.js").EvidenceReadInput,
  ) => s.evidenceRead(input, a),
  attachment: (
    s: Storage,
    a: Access,
    input: { id: string; path: string; sha256: string; offset?: number },
  ) => s.run(a, (vault) => vault.attachment(input)),
  records: (
    s: Storage,
    a: Access,
    input: Parameters<import("./vault.js").SampleVault["list"]>[0],
  ) => s.run(a, (vault) => vault.list(input)),
  record: (s: Storage, a: Access, input: Parameters<typeof inspectRecord>[1]) =>
    s.run(a, (vault) => inspectRecord(vault, input)),
  ontology: (s: Storage, a: Access, input: Parameters<typeof inspectOntology>[1]) =>
    s.run(a, (vault) => inspectOntology(vault, input)),
  diagnostics: (s: Storage, a: Access) =>
    s.run(a, async (vault) => {
      const data = await vault.scan();
      const mergeCandidates = findMergeCandidates(eligible(data, undefined, false));
      return {
        issues: data.issues.slice(0, 1000),
        total: data.issues.length,
        truncated: data.issues.length > 1000,
        checkedAt: data.checkedAt,
        ...(mergeCandidates.length ? { mergeCandidates } : {}),
      };
    }),
  // Catalog facts for the status operation; service-level fields stay on the main thread.
  catalog: (s: Storage, a: Access) => s.run(a, async (vault) => catalogFacts(await vault.scan())),
  memoryGet: (
    s: Storage,
    a: Access,
    input: { id: string; revision?: string; from: number; count: number },
  ) =>
    s.run(a, async (vault) => {
      const data = await vault.scan();
      const r = eligible(data, undefined, false).find(
        (record) => record.id === input.id && record.lifecycle === "active",
      );
      if (!r) {
        return { status: "not_found" as const };
      }
      if (input.revision !== undefined && input.revision !== revision(r)) {
        throw new Error("Knowledge record changed; search again before reading this revision.");
      }
      const text = `# ${r.title}\n${attribution(r.metadata.assertion_origin, r.metadata.attribution)}\n${r.body}`;
      const all = text.split("\n"),
        chunk = all.slice(input.from - 1, input.from - 1 + input.count);
      const result = {
        status: "ok" as const,
        record: { id: r.id, title: r.title, path: r.path, revision: r.revision, hash: r.hash },
        evidence: (r.metadata.evidence ?? []).slice(0, 20),
        text: chunk.join("\n"),
        lines: chunk.length,
        total: all.length,
      };
      // Line counts alone cannot bound a single very large paragraph. Never skip its tail.
      while (!withinBudget(result) && result.evidence.length) {
        result.evidence.pop();
      }
      while (!withinBudget(result) && chunk.length > 1) {
        chunk.pop();
        result.text = chunk.join("\n");
        result.lines = chunk.length;
      }
      if (!withinBudget(result)) {
        throw new Error(
          "Memory line exceeds transport budget; use knowledge_record with content offsets to read this record without losing text.",
        );
      }
      return result;
    }),
  memoryCandidates: (
    s: Storage,
    a: Access,
    input: { kind: "trigger" | "project"; limit: number },
  ) => s.memoryCandidates(input, a),
  memoryIndex: (s: Storage, a: Access, input: In<Storage["memoryIndex"]>) =>
    s.memoryIndex(input, a),
  memoryHealth: (s: Storage, a: Access) =>
    s.run(a, async (vault) => {
      const data = await vault.scan();
      return {
        ontology: Boolean(data.ontology),
        issues: data.issues.length,
        records: eligible(data, undefined, false).length,
      };
    }),
};
export type StorageOperations = typeof operations;

/** Serve storage calls one at a time. Authority checks block this worker on a
 * shared flag while the main thread re-evaluates the caller's live authority. */
export function serve(port: MessagePort, init: { config: StoreConfig; signal: SharedArrayBuffer }) {
  const storage = new KnowledgeStorage(init.config),
    signal = new Int32Array(init.signal);
  let queue: Promise<void> = Promise.resolve();
  port.on("message", (message: HostMessage<keyof StorageOperations>) => {
    if (message.type !== "call") {
      return;
    }
    queue = queue.then(async () => {
      const access: Access = {
        scope: message.scope,
        agentId: message.agentId,
        activity: message.activity ? { ...message.activity, operation: message.op } : undefined,
        assertCurrent() {
          Atomics.store(signal, 0, 0);
          port.postMessage({ type: "assert", id: message.id } satisfies WorkerMessage);
          if (Atomics.wait(signal, 0, 0, 120_000) === "timed-out") {
            throw new Error("Knowledge authority check timed out.");
          }
          if (Atomics.load(signal, 1) !== 1) {
            throw new Error(AUTHORITY_REVOKED);
          }
        },
      };
      try {
        // SAFETY: messages name only operations in this table, sent by StorageClient.
        const run = operations[message.op] as (s: Storage, a: Access, input: unknown) => unknown;
        port.postMessage({
          type: "done",
          id: message.id,
          ok: true,
          value: await storage.trackRead(access, message.op, () =>
            run(storage, access, message.input),
          ),
        } satisfies WorkerMessage);
      } catch (error) {
        port.postMessage({
          type: "done",
          id: message.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        } satisfies WorkerMessage);
      }
    });
  });
}
