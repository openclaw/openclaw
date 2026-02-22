/**
 * CLI commands for the Docling RAG extension.
 *
 * Registers `openclaw docs` with subcommands:
 *   ingest <path>   — Ingest a document or folder
 *   search <query>  — Search the knowledge base
 *   list            — List ingested documents
 *   remove <name>   — Remove a document
 *   status          — Show extension status
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import type { DoclingClient } from "./docling-client.js";
import type { DoclingServerManager } from "./server-manager.js";
import type { DocumentStore } from "./store.js";
import { SUPPORTED_EXTENSIONS } from "./types.js";

export function registerDoclingCli(params: {
  program: Command;
  store: DocumentStore;
  client: DoclingClient;
  serverManager: DoclingServerManager;
  ensureDocling: () => Promise<void>;
}): void {
  const { program, store, client, serverManager, ensureDocling } = params;

  const docs = program
    .command("docs")
    .description("Document processing and knowledge base (Docling RAG)");

  docs
    .command("ingest <path>")
    .description("Ingest a document or all supported files in a folder")
    .action(async (inputPath: string) => {
      const resolved = path.resolve(inputPath.replace(/^~/, process.env.HOME ?? "~"));

      if (!fs.existsSync(resolved)) {
        console.error(`Not found: ${resolved}`);
        process.exitCode = 1;
        return;
      }

      await ensureDocling();

      const stat = fs.statSync(resolved);

      if (stat.isFile()) {
        await ingestSingleFile(resolved, store, client);
        return;
      }

      if (stat.isDirectory()) {
        const files = fs
          .readdirSync(resolved)
          .filter((f) => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()))
          .map((f) => path.join(resolved, f));

        if (files.length === 0) {
          console.log(`No supported files found in ${resolved}`);
          return;
        }

        console.log(`Found ${files.length} supported file(s) in ${resolved}`);
        let ingested = 0;
        for (const file of files) {
          const ok = await ingestSingleFile(file, store, client);
          if (ok) {
            ingested++;
          }
        }
        console.log(`\nIngested ${ingested}/${files.length} file(s).`);
        return;
      }

      console.error(`${resolved} is not a file or directory`);
      process.exitCode = 1;
    });

  docs
    .command("search <query>")
    .description("Search across all ingested documents")
    .option("-n, --limit <number>", "Max results", "5")
    .action((query: string, opts: { limit: string }) => {
      const limit = Number.parseInt(opts.limit, 10) || 5;
      const results = store.searchByKeyword(query, limit);

      if (results.length === 0) {
        console.log(`No results for "${query}" across ${store.documentCount()} document(s).`);
        return;
      }

      console.log(`${results.length} result(s) for "${query}":\n`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const source = r.chunk.page ? `${r.document.name} (p${r.chunk.page})` : r.document.name;
        const section = r.chunk.section ? ` [${r.chunk.section}]` : "";
        console.log(`  ${i + 1}. ${source}${section} (score: ${r.score.toFixed(2)})`);
        console.log(`     ${r.chunk.text.slice(0, 200)}${r.chunk.text.length > 200 ? "..." : ""}`);
        console.log();
      }
    });

  docs
    .command("list")
    .description("List all ingested documents")
    .action(() => {
      const documents = store.listDocuments();

      if (documents.length === 0) {
        console.log("No documents ingested. Use `openclaw docs ingest <path>` to add files.");
        return;
      }

      console.log(`${documents.length} document(s) in knowledge base:\n`);
      for (const d of documents) {
        console.log(`  ${d.name}`);
        console.log(`    Format: ${d.format} | Pages: ${d.pages} | Chunks: ${d.chunks}`);
        console.log(`    Ingested: ${d.ingestedAt}`);
        console.log();
      }
      console.log(`Total: ${store.chunkCount()} chunks across ${documents.length} document(s)`);
    });

  docs
    .command("remove <name>")
    .description("Remove a document from the knowledge base by filename")
    .action((name: string) => {
      const doc = store.findDocumentByName(name);
      if (!doc) {
        console.error(`Document "${name}" not found.`);
        console.log("Available documents:");
        for (const d of store.listDocuments()) {
          console.log(`  - ${d.name}`);
        }
        process.exitCode = 1;
        return;
      }

      store.removeDocument(doc.id);
      console.log(`Removed "${doc.name}" (${doc.chunks} chunks).`);
    });

  docs
    .command("status")
    .description("Show Docling RAG extension status")
    .action(async () => {
      console.log("Docling RAG Status:\n");
      console.log(`  Server URL:  ${serverManager.getUrl()}`);
      console.log(
        `  Remote:      ${serverManager.isRemote() ? "yes (⚠ ensure HTTPS)" : "no (loopback)"}`,
      );
      console.log(
        `  Running:     ${serverManager.isStarted() ? "yes" : "no (lazy-start on first ingest)"}`,
      );
      console.log(`  Documents:   ${store.documentCount()}`);
      console.log(`  Chunks:      ${store.chunkCount()}`);

      if (serverManager.isStarted()) {
        const healthy = await client.healthCheck();
        console.log(`  Health:      ${healthy ? "ok" : "unhealthy"}`);
      }
    });
}

async function ingestSingleFile(
  filePath: string,
  store: DocumentStore,
  client: DoclingClient,
): Promise<boolean> {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    console.log(`  ⏭ ${name} — unsupported format (${ext})`);
    return false;
  }

  const existing = store.findDocumentByName(name);
  if (existing) {
    console.log(`  ⏭ ${name} — already ingested (${existing.chunks} chunks)`);
    return false;
  }

  try {
    const result = await client.chunkFile(filePath);
    const stat = fs.statSync(filePath);

    const doc = store.addDocument(
      {
        name,
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

    console.log(`  ✓ ${doc.name} (${doc.pages} pages, ${doc.chunks} chunks)`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name} — ${msg}`);
    return false;
  }
}
