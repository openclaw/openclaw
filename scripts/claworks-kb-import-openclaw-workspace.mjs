#!/usr/bin/env node
/**
 * Batch-ingest OpenClaw knowledge_base/content/* into ClaWorks KB with namespace mapping.
 * Optionally import ontology/*.json via existing capabilities (bootstrap_from_openapi + cw_import_objects).
 *
 *   set -a && source ~/.claworks/personal.env && set +a
 *   node scripts/claworks-kb-import-openclaw-workspace.mjs --all
 *   node scripts/claworks-kb-import-openclaw-workspace.mjs --category product_manual
 *   node scripts/claworks-kb-import-openclaw-workspace.mjs --ontology-only
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  OPENCLAW_KB_CONTENT_DIRS,
  OPENCLAW_KB_NAMESPACE_MAP,
  createKbClient,
  extractOntologyInstances,
  loadFileIndex,
  namespaceForCategory,
  ontologyJsonToOpenApiSchemas,
  resolveKbCategoryPath,
  resolveOpenclawKbRoot,
} from "./lib/openclaw-kb.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    category: { type: "string", short: "c", multiple: true },
    "kb-root": { type: "string" },
    "ontology-only": { type: "boolean", default: false },
    "skip-ontology": { type: "boolean", default: false },
    "skip-kb": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/claworks-kb-import-openclaw-workspace.mjs [options]

Options:
  --all                 Ingest all content/ categories (${OPENCLAW_KB_CONTENT_DIRS.join(", ")})
  --category NAME       Ingest one category (repeatable)
  --kb-root PATH        Override CLAWORKS_OPENCLAW_KB_ROOT
  --ontology-only       Import ontology/*.json only
  --skip-ontology       Skip ontology import
  --ontology            Also import ontology/*.json (with --category)
  --skip-kb             Skip KB folder ingest
  --dry-run             Print plan without calling gateway

Namespace map:
${Object.entries(OPENCLAW_KB_NAMESPACE_MAP)
  .map(([k, v]) => `  content/${k} → namespace "${v}"`)
  .join("\n")}
`);
  process.exit(0);
}

const kbRoot = values["kb-root"]?.trim() || resolveOpenclawKbRoot();
const { base, jfetch, mcpCall } = createKbClient();

console.log(`[openclaw-kb-import] kb_root=${kbRoot} gateway=${base}`);

if (!existsSync(kbRoot)) {
  console.error(
    `[openclaw-kb-import] KB root not found. Mount SMB or set CLAWORKS_OPENCLAW_KB_ROOT.`,
  );
  console.error(`  Expected: ${kbRoot}`);
  process.exit(1);
}

const fileIndex = loadFileIndex(kbRoot);
if (fileIndex) {
  const count =
    (Array.isArray(fileIndex) && fileIndex.length) ||
    (Array.isArray(fileIndex.files) && fileIndex.files.length) ||
    (typeof fileIndex === "object" && Object.keys(fileIndex).length);
  console.log(`[openclaw-kb-import] file_index.json loaded (${count ?? "?"} entries)`);
} else {
  console.log("[openclaw-kb-import] metadata/file_index.json not used (missing or unreadable)");
}

function resolveCategories() {
  if (values.all) {
    return OPENCLAW_KB_CONTENT_DIRS;
  }
  const fromFlag = values.category ?? [];
  const fromPos = positionals.filter((p) => OPENCLAW_KB_CONTENT_DIRS.includes(p));
  const cats = [...fromFlag, ...fromPos];
  if (cats.length === 0 && !values["ontology-only"]) {
    return OPENCLAW_KB_CONTENT_DIRS;
  }
  return cats;
}

async function ingestCategory(category) {
  const folder = resolveKbCategoryPath(category, kbRoot);
  const namespace = namespaceForCategory(category);
  if (!existsSync(folder)) {
    console.warn(`[openclaw-kb-import] skip ${category}: folder missing (${folder})`);
    return { category, skipped: true };
  }
  const sourcePrefix = `openclaw-kb/${category}`;
  console.log(`[openclaw-kb-import] ingest ${category} → namespace=${namespace}`);
  if (values["dry-run"]) {
    return { category, namespace, folder, dryRun: true };
  }
  const result = await jfetch("/v1/kb/ingest/folder", {
    method: "POST",
    body: JSON.stringify({
      folder_path: folder,
      namespace,
      recursive: true,
      source_prefix: sourcePrefix,
    }),
  });
  console.log(
    `  ingested=${result.ingested ?? "?"} errors=${result.errors ?? "?"} total=${result.total ?? "?"}`,
  );
  return { category, namespace, ...result };
}

async function importOntologyFile(filename, pack) {
  const path = join(kbRoot, "ontology", filename);
  if (!existsSync(path)) {
    console.warn(`[openclaw-kb-import] ontology skip: ${path} missing`);
    return { file: filename, skipped: true };
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const schemas = ontologyJsonToOpenApiSchemas(doc);
  const typeNames = Object.keys(schemas);
  console.log(`[openclaw-kb-import] ontology ${filename}: ${typeNames.length} type(s)`);

  if (values["dry-run"]) {
    return { file: filename, types: typeNames, dryRun: true };
  }

  let bootstrap = { status: "skipped", registered_count: 0 };
  if (typeNames.length > 0) {
    bootstrap = await mcpCall("cw_invoke_capability", {
      capability_id: "ontology.bootstrap_from_openapi",
      params: {
        openapi_json: JSON.stringify({ components: { schemas } }),
        pack,
      },
      source: "openclaw-kb-import",
    });
    console.log(`  bootstrap_from_openapi: ${JSON.stringify(bootstrap)}`);
  }

  const instances = extractOntologyInstances(doc);
  let imported = 0;
  for (const [typeName, records] of instances) {
    if (records.length === 0) {
      continue;
    }
    const batch = await mcpCall("cw_import_objects", {
      type_name: typeName,
      records,
    });
    imported += batch.imported ?? records.length;
    console.log(`  cw_import_objects ${typeName}: ${batch.imported ?? records.length}`);
  }

  return { file: filename, types: typeNames, bootstrap, instances_imported: imported };
}

async function importOntology() {
  const files = [
    { name: "enterprise_ontology.json", pack: "enterprise" },
    { name: "relationship_ontology.json", pack: "enterprise" },
    { name: "industry_ontology.json", pack: "enterprise" },
  ];
  const results = [];
  for (const f of files) {
    results.push(await importOntologyFile(f.name, f.pack));
  }
  return results;
}

const summary = { kb: [], ontology: [] };

if (!values["skip-kb"] && !values["ontology-only"]) {
  for (const category of resolveCategories()) {
    if (!OPENCLAW_KB_NAMESPACE_MAP[category] && category !== values.category) {
      console.warn(`[openclaw-kb-import] unknown category: ${category}`);
    }
    summary.kb.push(await ingestCategory(category));
  }
  if (!values["dry-run"]) {
    await jfetch("/v1/kb/flush", { method: "POST", body: "{}" });
    console.log("[openclaw-kb-import] kb flush OK");
  }
}

const shouldImportOntology =
  !values["skip-ontology"] &&
  (values["ontology-only"] || values.all || process.argv.includes("--ontology"));

if (!values["skip-ontology"] && shouldImportOntology) {
  summary.ontology = await importOntology();
}

console.log("[openclaw-kb-import] done:", JSON.stringify(summary, null, 2));
