#!/usr/bin/env node
import { existsSync } from "node:fs";
/**
 * Batch-ingest a single folder into ClaWorks KB via POST /v1/kb/ingest/folder.
 *
 *   CLAWORKS_API_KEY=... node scripts/claworks-kb-ingest-folder.mjs \
 *     --folder /Volumes/Macintosh\ HD/Users/m/.openclaw/workspace/knowledge_base/content/product_manual \
 *     --namespace products
 */
import { parseArgs } from "node:util";
import { createKbClient } from "./lib/openclaw-kb.mjs";

const { values } = parseArgs({
  options: {
    folder: { type: "string", short: "f" },
    namespace: { type: "string", short: "n", default: "work" },
    "source-prefix": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !values.folder) {
  console.log(`Usage: node scripts/claworks-kb-ingest-folder.mjs --folder PATH [--namespace NS]

  POST /v1/kb/ingest/folder on running ClaWorks gateway (Markdown/txt/json/yaml/csv).
`);
  process.exit(values.help ? 0 : 1);
}

const folder = values.folder.trim();
if (!existsSync(folder)) {
  console.error(`[kb-ingest-folder] folder not found: ${folder}`);
  process.exit(1);
}

const { base, jfetch } = createKbClient();
console.log(`[kb-ingest-folder] base=${base} folder=${folder} namespace=${values.namespace}`);

const result = await jfetch("/v1/kb/ingest/folder", {
  method: "POST",
  body: JSON.stringify({
    folder_path: folder,
    namespace: values.namespace,
    recursive: true,
    source_prefix: values["source-prefix"],
  }),
});

console.log(
  `[kb-ingest-folder] ingested=${result.ingested ?? "?"} errors=${result.errors ?? "?"} total=${result.total ?? "?"}`,
);

await jfetch("/v1/kb/flush", { method: "POST", body: "{}" });
console.log("[kb-ingest-folder] flush OK");
