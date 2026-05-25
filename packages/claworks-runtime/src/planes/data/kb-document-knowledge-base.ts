import { readFileSync } from "node:fs";
import type { KnowledgeBase, KbIngestOptions, KbResult } from "../../kernel/types.js";
import type { CwDatabase } from "./db-types.js";
import { chunkKbText, deriveDocumentTitle, inferDocType, inferKbLayer } from "./kb-chunk.js";
import { ingestKbFolder } from "./kb-folder-ingest.js";
import { canPublishDocument, lintKbDocument } from "./kb-refinery.js";
import { createKbStore, hashKbContent, type KbStore } from "./kb-store.js";
import type {
  DocumentKnowledgeBase,
  KbCreateIngestJobParams,
  KbIngestDocumentParams,
  KbLayer,
  KbListDocumentsParams,
} from "./kb-types.js";

function mergeResults(primary: KbResult[], secondary: KbResult[], limit: number): KbResult[] {
  const seen = new Set<string>();
  const merged: KbResult[] = [];
  for (const result of [...primary, ...secondary]) {
    const key = `${result.document_id ?? ""}:${result.chunk_id ?? ""}:${result.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}

function chunkToResult(params: {
  chunkId: string;
  document: {
    id: string;
    title: string;
    source?: string;
    namespace?: string;
    layer: KbLayer;
    revision: number;
  };
  text: string;
  citation?: string;
  score: number;
}): KbResult {
  return {
    id: params.chunkId,
    score: params.score,
    text: params.text,
    source: params.document.source,
    namespace: params.document.namespace,
    document_id: params.document.id,
    chunk_id: params.chunkId,
    layer: params.document.layer,
    citation: params.citation,
    revision: params.document.revision,
    title: params.document.title,
  };
}

export function createDocumentKnowledgeBase(
  db: CwDatabase,
  inner: KnowledgeBase,
): DocumentKnowledgeBase {
  const store = createKbStore(db);

  async function indexDocumentChunks(
    document: NonNullable<ReturnType<KbStore["getDocument"]>>,
    chunks: ReturnType<KbStore["insertChunks"]>,
  ): Promise<void> {
    for (const chunk of chunks) {
      await inner.ingest(chunk.text, {
        namespace: document.namespace,
        source: document.source ?? document.title,
        document_id: document.id,
        chunk_id: chunk.id,
        layer: document.layer,
        citation: chunk.citation,
        title: document.title,
      });
    }
  }

  async function ingestDocument(params: KbIngestDocumentParams) {
    const text = params.text.trim();
    if (!text) {
      throw new Error("text is required");
    }
    const docType = params.doc_type ?? inferDocType(params.source, text);
    const layer =
      params.layer ??
      inferKbLayer({ source: params.source, doc_type: docType, namespace: params.namespace });
    const title = deriveDocumentTitle({ title: params.title, source: params.source, text });
    const document = store.insertDocument({
      title,
      source: params.source,
      layer,
      doc_type: docType,
      namespace: params.namespace,
      status: params.auto_publish ? "published" : "draft",
      content_hash: hashKbContent(text),
      metadata: params.metadata ?? {},
    });
    const chunks = store.insertChunks(
      document.id,
      chunkKbText({ text, source: params.source, layer }),
    );
    await indexDocumentChunks(document, chunks);
    if (params.auto_publish) {
      const lint = lintKbDocument(store, document.id);
      if (!canPublishDocument(document, lint)) {
        store.updateDocumentStatus(document.id, "reviewing");
        return store.getDocument(document.id)!;
      }
      return store.updateDocumentStatus(document.id, "published")!;
    }
    return document;
  }

  return {
    async search(query, opts) {
      const limit = opts?.limit ?? 5;
      const structured = store.searchPublishedChunks({
        query,
        limit,
        namespace: opts?.namespace,
        layer: opts?.layer as KbLayer | undefined,
      });
      const structuredResults = structured.map(({ chunk, document, score }) =>
        chunkToResult({
          chunkId: chunk.id,
          document,
          text: chunk.text,
          citation: chunk.citation,
          score,
        }),
      );
      const vectorResults = await inner.search(query, opts);
      const enrichedVector = vectorResults.map((result) => {
        if (result.document_id) {
          return result;
        }
        const doc = structured.find(
          (hit) =>
            hit.chunk.text === result.text ||
            result.source === hit.document.source ||
            result.id === hit.chunk.id,
        );
        if (!doc) {
          return result;
        }
        return Object.assign({}, result, {
          document_id: doc.document.id,
          chunk_id: doc.chunk.id,
          layer: doc.document.layer,
          citation: doc.chunk.citation,
          revision: doc.document.revision,
          title: doc.document.title,
        });
      });
      return mergeResults(enrichedVector, structuredResults, limit);
    },

    async ingest(text, opts?: KbIngestOptions) {
      if (opts?.document_id && opts.chunk_id) {
        await inner.ingest(text, opts);
        return;
      }
      await ingestDocument({
        text,
        source: opts?.source,
        namespace: opts?.namespace,
        layer: opts?.layer as KbLayer | undefined,
        title: opts?.title,
        auto_publish: true,
      });
    },

    flush: inner.flush?.bind(inner),

    async describe() {
      const innerStatus = inner.describe ? await inner.describe() : undefined;
      return {
        provider: "document" as const,
        vector: innerStatus?.vector ?? false,
        kb_path: innerStatus?.kb_path,
        kb_embed_model: innerStatus?.kb_embed_model,
        kb_drop_dir: innerStatus?.kb_drop_dir,
        memory_slot: innerStatus?.memory_slot,
        document_count: store.countDocuments(),
        published_document_count: store.countDocuments("published"),
        chunk_count: store.countChunks(),
        pending_ingest_jobs: store.countIngestJobs("pending") + store.countIngestJobs("running"),
        note:
          innerStatus?.note ??
          "Twin document store (authoritative metadata) + inner KB provider for recall",
      };
    },

    ingestDocument,
    async getDocument(id: string) {
      const doc = store.getDocument(id);
      if (!doc) {
        return null;
      }
      return { ...doc, chunks: store.listChunks(id) };
    },
    async listDocuments(params?: KbListDocumentsParams) {
      return store.listDocuments(params);
    },
    async publishDocument(id) {
      const doc = store.getDocument(id);
      if (!doc) {
        throw new Error(`Document not found: ${id}`);
      }
      const lint = lintKbDocument(store, id);
      if (!canPublishDocument(doc, lint)) {
        store.updateDocumentStatus(id, "reviewing");
        throw new Error(
          `Document failed lint (${lint.issues.filter((i) => i.severity === "error").length} errors)`,
        );
      }
      const published = store.updateDocumentStatus(id, "published");
      if (!published) {
        throw new Error(`Document not found: ${id}`);
      }
      return published;
    },
    lintDocument(id) {
      return lintKbDocument(store, id);
    },
    createIngestJob(params: KbCreateIngestJobParams) {
      const seedReport: Record<string, unknown> = {};
      if (params.text?.trim()) {
        seedReport.inline_text = params.text;
        if (params.title) {
          seedReport.inline_title = params.title;
        }
        if (params.source) {
          seedReport.inline_source = params.source;
        }
        if (params.auto_publish != null) {
          seedReport.auto_publish = params.auto_publish;
        }
      }
      return store.createIngestJob({ ...params, report: seedReport } as KbCreateIngestJobParams);
    },
    async processIngestJob(jobId) {
      const job = store.getIngestJob(jobId);
      if (!job) {
        throw new Error(`Ingest job not found: ${jobId}`);
      }
      store.updateIngestJob(jobId, { status: "running", error: undefined });
      try {
        const report: Record<string, unknown> = { documents: [] as unknown[] };
        if (job.folder_path) {
          const folderResult = await ingestKbFolder(
            {
              search: async () => [],
              ingest: async (text, opts) => {
                const doc = await ingestDocument({
                  text,
                  source: opts?.source,
                  namespace: job.namespace ?? opts?.namespace,
                  layer: job.layer,
                  doc_type: job.doc_type,
                  auto_publish: Boolean(job.report.auto_publish),
                });
                (report.documents as unknown[]).push({
                  id: doc.id,
                  title: doc.title,
                  source: doc.source,
                });
              },
            },
            {
              folder_path: job.folder_path,
              namespace: job.namespace,
              recursive: true,
              source_prefix: job.source_path,
            },
          );
          report.folder = folderResult;
        } else if (job.source_path) {
          const text = readFileSync(job.source_path, "utf8");
          const doc = await ingestDocument({
            text,
            source: job.source_path,
            namespace: job.namespace,
            layer: job.layer,
            doc_type: job.doc_type,
            auto_publish: Boolean(job.report.auto_publish),
          });
          (report.documents as unknown[]).push({
            id: doc.id,
            title: doc.title,
            source: doc.source,
          });
        } else if (typeof job.report.inline_text === "string") {
          const doc = await ingestDocument({
            text: String(job.report.inline_text),
            title:
              typeof job.report.inline_title === "string" ? job.report.inline_title : undefined,
            source:
              typeof job.report.inline_source === "string" ? job.report.inline_source : undefined,
            namespace: job.namespace,
            layer: job.layer,
            doc_type: job.doc_type,
            auto_publish: Boolean(job.report.auto_publish),
          });
          (report.documents as unknown[]).push({
            id: doc.id,
            title: doc.title,
            source: doc.source,
          });
        } else {
          throw new Error("ingest job requires folder_path, source_path, or inline text");
        }
        if (typeof inner.flush === "function") {
          await inner.flush();
        }
        const completed = store.updateIngestJob(jobId, {
          status: "completed",
          report,
          completed_at: Date.now(),
        });
        return completed!;
      } catch (err) {
        const failed = store.updateIngestJob(jobId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          completed_at: Date.now(),
        });
        return failed!;
      }
    },

    // 透传 inner KB 的 semanticSearch / provider / supportsEmbedding
    semanticSearch: inner.semanticSearch
      ? (query, opts) => inner.semanticSearch!(query, opts)
      : undefined,
    provider: inner.provider ?? "document",
    supportsEmbedding: inner.supportsEmbedding ?? false,
  };
}
