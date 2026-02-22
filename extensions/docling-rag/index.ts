/**
 * Docling RAG Extension for OpenClaw
 *
 * Provides native document processing via IBM's Docling library.
 * Ingests PDFs, Word, PowerPoint, Excel, and more — then makes them
 * searchable by the agent via keyword search.
 *
 * Uses docling-serve as the document conversion backend (auto-managed
 * or externally provided). Documents are chunked and stored locally.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DoclingClient } from "./src/docling-client.js";
import { DoclingServerManager } from "./src/server-manager.js";
import { DocumentStore } from "./src/store.js";
import {
  DEFAULT_DOCLING_SERVE_URL,
  DEFAULT_STORE_PATH,
  SUPPORTED_EXTENSIONS,
  type DoclingRagConfig,
} from "./src/types.js";

function resolveConfig(raw: unknown): DoclingRagConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    doclingServeUrl: typeof cfg.doclingServeUrl === "string" ? cfg.doclingServeUrl : undefined,
    autoManage: typeof cfg.autoManage === "boolean" ? cfg.autoManage : true,
    watchDir: typeof cfg.watchDir === "string" ? cfg.watchDir : undefined,
    storePath: typeof cfg.storePath === "string" ? cfg.storePath : DEFAULT_STORE_PATH,
    chunkSize: typeof cfg.chunkSize === "number" ? cfg.chunkSize : undefined,
    chunkOverlap: typeof cfg.chunkOverlap === "number" ? cfg.chunkOverlap : undefined,
  };
}

const plugin = {
  id: "docling-rag",
  name: "Docling RAG",
  description: "Document processing and RAG via IBM Docling — ingest PDFs, Word, Excel, PowerPoint",
  configSchema: {},

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    const serverUrl = cfg.doclingServeUrl ?? DEFAULT_DOCLING_SERVE_URL;
    const storePath = (cfg.storePath ?? DEFAULT_STORE_PATH).replace(/^~/, process.env.HOME ?? "~");
    const serverManager = new DoclingServerManager(serverUrl);
    const client = new DoclingClient(serverUrl);
    const store = new DocumentStore(storePath);

    async function ensureDocling(): Promise<void> {
      if (cfg.autoManage !== false) {
        await serverManager.ensureRunning();
      }
    }

    // =====================================================================
    // Agent Tools
    // =====================================================================

    api.registerTool({
      name: "ingest_document",
      label: "Ingest Document",
      description:
        "Process a document (PDF, Word, PowerPoint, Excel, HTML, image) and add it to the knowledge base for future queries. Provide the file path.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path to the document file" }),
      }),
      async execute(_toolCallId: string, params: { path: string }) {
        await ensureDocling();
        const filePath = params.path.replace(/^~/, process.env.HOME ?? "~");

        if (!fs.existsSync(filePath)) {
          return {
            content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
            details: { error: "file_not_found" },
          };
        }

        const ext = path.extname(filePath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unsupported format: ${ext}. Supported: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
              },
            ],
            details: { error: "unsupported_format" },
          };
        }

        const existing = store.findDocumentByName(path.basename(filePath));
        if (existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Document "${existing.name}" is already ingested (${existing.chunks} chunks). Use remove_document first to re-ingest.`,
              },
            ],
            details: { documentId: existing.id, alreadyExists: true },
          };
        }

        try {
          const result = await client.chunkFile(filePath);
          const stat = fs.statSync(filePath);

          const doc = store.addDocument(
            {
              name: path.basename(filePath),
              path: filePath,
              format: result.format,
              pages: result.pages,
              sizeBytes: stat.size,
            },
            result.chunks.map((c) => ({
              text: c.text,
              page: c.page,
              section: c.section,
            })),
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `Ingested "${doc.name}" — ${doc.pages} pages, ${doc.chunks} chunks.`,
              },
            ],
            details: { documentId: doc.id, name: doc.name, pages: doc.pages, chunks: doc.chunks },
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Failed to ingest document: ${msg}` }],
            details: { error: msg },
          };
        }
      },
    });

    api.registerTool({
      name: "search_knowledge",
      label: "Search Knowledge Base",
      description:
        "Search across all ingested documents for information relevant to the query. Returns the most relevant text passages with source citations.",
      parameters: Type.Object({
        query: Type.String({ description: "The search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
      }),
      async execute(_toolCallId: string, params: { query: string; limit?: number }) {
        const results = store.searchByKeyword(params.query, params.limit ?? 5);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${params.query}" across ${store.documentCount()} documents.`,
              },
            ],
            details: { results: [], query: params.query },
          };
        }

        const formatted = results
          .map((r, i) => {
            const source = r.chunk.page
              ? `${r.document.name} (page ${r.chunk.page})`
              : r.document.name;
            const section = r.chunk.section ? ` [${r.chunk.section}]` : "";
            return `${i + 1}. **${source}**${section} (score: ${r.score.toFixed(2)})\n   ${r.chunk.text.slice(0, 300)}${r.chunk.text.length > 300 ? "..." : ""}`;
          })
          .join("\n\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: {
            results: results.map((r) => ({
              documentName: r.document.name,
              score: r.score,
              page: r.chunk.page,
            })),
            query: params.query,
          },
        };
      },
    });

    api.registerTool({
      name: "list_documents",
      label: "List Documents",
      description: "List all documents in the knowledge base.",
      parameters: Type.Object({}),
      async execute() {
        const docs = store.listDocuments();

        if (docs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No documents ingested yet. Use ingest_document to add files.",
              },
            ],
            details: { documents: [] },
          };
        }

        const formatted = docs
          .map(
            (d) =>
              `- **${d.name}** (${d.format}, ${d.pages} pages, ${d.chunks} chunks, ingested ${d.ingestedAt})`,
          )
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `${docs.length} document(s) in knowledge base:\n\n${formatted}`,
            },
          ],
          details: {
            documents: docs.map((d) => ({
              id: d.id,
              name: d.name,
              format: d.format,
              pages: d.pages,
              chunks: d.chunks,
            })),
          },
        };
      },
    });

    api.registerTool({
      name: "remove_document",
      label: "Remove Document",
      description: "Remove a document from the knowledge base by name.",
      parameters: Type.Object({
        name: Type.String({ description: "Document filename to remove" }),
      }),
      async execute(_toolCallId: string, params: { name: string }) {
        const doc = store.findDocumentByName(params.name);
        if (!doc) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Document "${params.name}" not found in knowledge base.`,
              },
            ],
            details: { error: "not_found" },
          };
        }

        store.removeDocument(doc.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed "${doc.name}" (${doc.chunks} chunks removed).`,
            },
          ],
          details: { documentId: doc.id, name: doc.name },
        };
      },
    });

    // =====================================================================
    // Service (managed docling-serve lifecycle)
    // =====================================================================

    if (cfg.autoManage !== false) {
      // Service exists primarily for clean shutdown. Start is a no-op because
      // docling-serve is lazy-started on first document ingestion via ensureDocling().
      // This avoids consuming ~500MB RAM when the user never uses RAG.
      api.registerService({
        id: "docling-serve",
        async start() {},
        async stop() {
          await serverManager.stop();
        },
      });
    }
  },
};

export default plugin;
