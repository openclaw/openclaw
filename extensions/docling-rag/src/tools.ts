import { Type } from "@sinclair/typebox";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { chunkMarkdown } from "./chunker.js";
import { parseConfig } from "./config.js";
import { isSupportedFormat, runDocling } from "./docling-runner.js";
import { DoclingStore } from "./storage.js";

export function createDoclingTools(api: OpenClawPluginApi) {
  const cfg = parseConfig(api.pluginConfig);
  if (!cfg.enabled || !cfg.embedding.apiKey) {
    return [];
  }

  const resolvedDbPath = api.resolvePath(cfg.dbPath);
  const store = new DoclingStore(
    resolvedDbPath,
    cfg.embedding.apiKey,
    cfg.embedding.model,
  );

  return [
    {
      name: "ingest_document",
      label: "Ingest Document",
      description:
        "Ingest a document (PDF, Word, Excel, etc.) for later search. Use when the user sends or references a document path.",
      parameters: Type.Object({
        path: Type.String({
          description: "Absolute or workspace-relative path to the document file",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const filePath = typeof params.path === "string" ? params.path.trim() : "";
        if (!filePath) {
          throw new Error("path is required");
        }
        const resolved = api.resolvePath(filePath);
        if (!isSupportedFormat(resolved)) {
          throw new Error(
            `Unsupported format. Supported: PDF, DOCX, PPTX, XLSX, HTML, MD, images`,
          );
        }

        const result = await runDocling(resolved, {
          doclingPath: cfg.doclingPath,
          timeoutMs: 120_000,
        });

        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to process document: ${result.error}` }],
            details: { ok: false, error: result.error },
          };
        }

        const chunks = chunkMarkdown(result.markdown, {
          maxChars: cfg.chunkSize,
          overlap: cfg.chunkOverlap,
        });

        const documentId = `doc-${Date.now()}-${path.basename(resolved)}`;
        const documentName = path.basename(resolved);
        const count = await store.ingest(documentId, documentName, resolved, chunks);

        return {
          content: [
            {
              type: "text" as const,
              text: `Ingested "${documentName}" (${count} chunks). You can now search it with search_knowledge.`,
            },
          ],
          details: { ok: true, documentId, documentName, chunkCount: count },
        };
      },
    },
    {
      name: "search_knowledge",
      label: "Search Knowledge",
      description:
        "Search through ingested documents. Use when the user asks about content from previously ingested documents.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          throw new Error("query is required");
        }
        const limit = typeof params.limit === "number" ? Math.min(10, Math.max(1, params.limit)) : 5;

        const results = await store.search(query, limit);
        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No relevant documents found." }],
            details: { count: 0 },
          };
        }

        const text = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.chunk.documentName}${r.chunk.section ? ` - ${r.chunk.section}` : ""}] (${(r.score * 100).toFixed(0)}%)\n${r.chunk.text}`,
          )
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text" as const, text: `Found ${results.length} relevant chunks:\n\n${text}` }],
          details: { count: results.length },
        };
      },
    },
    {
      name: "list_documents",
      label: "List Documents",
      description: "List all ingested documents.",
      parameters: Type.Object({}),
      async execute() {
        const docs = await store.listDocuments();
        if (docs.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No documents ingested yet." }],
            details: { count: 0 },
          };
        }
        const text = docs
          .map(
            (d, i) =>
              `${i + 1}. ${d.name} (${d.chunkCount} chunks) - ingested ${new Date(d.createdAt).toLocaleDateString()}`,
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Ingested documents:\n\n${text}` }],
          details: { count: docs.length },
        };
      },
    },
    {
      name: "remove_document",
      label: "Remove Document",
      description: "Remove a document from the knowledge base.",
      parameters: Type.Object({
        documentId: Type.String({ description: "Document ID from list_documents" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const documentId = typeof params.documentId === "string" ? params.documentId.trim() : "";
        if (!documentId) {
          throw new Error("documentId is required");
        }
        const removed = await store.removeDocument(documentId);
        return {
          content: [
            {
              type: "text" as const,
              text: removed ? "Document removed." : "Document not found.",
            },
          ],
          details: { removed },
        };
      },
    },
  ];
}
