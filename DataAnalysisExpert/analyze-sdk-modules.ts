/**
 * Analyze plugin-sdk-api-baseline.json:
 * - extract all .ts source paths and group them
 * - find cross-module export similarities (shared types, shared source files)
 * - classify export kinds (function, type, const, interface, class)
 * - produce a JSON "form schema" framework output describing each module as a form
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const raw = JSON.parse(
  readFileSync(join(__dirname, "..", "docs", ".generated", "plugin-sdk-api-baseline.json"), "utf-8"),
);
const modules: Array<{
  category: string;
  entrypoint: string;
  importSpecifier: string;
  exports: Array<{
    declaration: string;
    exportName: string;
    kind: string;
    source: { line: number; path: string };
  }>;
}> = raw.modules;

// ── 1. Source-file frequency map ──
const sourceFileMap = new Map<string, { modules: Set<string>; exports: string[] }>();
for (const mod of modules) {
  for (const exp of mod.exports) {
    const p = exp.source.path;
    if (!sourceFileMap.has(p)) sourceFileMap.set(p, { modules: new Set(), exports: [] });
    sourceFileMap.get(p)!.modules.add(mod.entrypoint);
    sourceFileMap.get(p)!.exports.push(exp.exportName);
  }
}

// ── 2. Cross-module shared source files (appear in 2+ modules) ──
const sharedSources: Record<string, { modules: string[]; exports: string[] }> = {};
for (const [path, info] of sourceFileMap) {
  if (info.modules.size > 1) {
    sharedSources[path] = { modules: [...info.modules], exports: info.exports };
  }
}

// ── 3. Cross-module shared export names ──
const exportNameMap = new Map<string, string[]>();
for (const mod of modules) {
  for (const exp of mod.exports) {
    if (!exportNameMap.has(exp.exportName)) exportNameMap.set(exp.exportName, []);
    exportNameMap.get(exp.exportName)!.push(mod.entrypoint);
  }
}
const sharedExports: Record<string, string[]> = {};
for (const [name, mods] of exportNameMap) {
  if (mods.length > 1) sharedExports[name] = mods;
}

// ── 4. Per-category summary ──
const categoryStats: Record<string, { modules: string[]; totalExports: number; kinds: Record<string, number> }> = {};
for (const mod of modules) {
  if (!categoryStats[mod.category]) categoryStats[mod.category] = { modules: [], totalExports: 0, kinds: {} };
  categoryStats[mod.category].modules.push(mod.entrypoint);
  categoryStats[mod.category].totalExports += mod.exports.length;
  for (const exp of mod.exports) {
    categoryStats[mod.category].kinds[exp.kind] = (categoryStats[mod.category].kinds[exp.kind] || 0) + 1;
  }
}

// ── 5. Per-module "form schema" ──
// Treat each module as a form whose "fields" are its exported functions/types.
// Functions → action buttons; Types → form field descriptors; Constants → read-only fields.
interface FormField {
  name: string;
  kind: "action" | "type-descriptor" | "constant" | "interface" | "class";
  declaration: string;
  sourceFile: string;
  sourceLine: number;
  parameters?: string[];
  returnType?: string;
}

interface ModuleForm {
  id: string;
  category: string;
  importSpecifier: string;
  fields: FormField[];
  actionCount: number;
  typeCount: number;
  constCount: number;
}

function extractParams(decl: string): string[] {
  const match = decl.match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().split(":")[0]?.trim())
    .filter(Boolean);
}

function extractReturnType(decl: string): string | undefined {
  // For functions, grab what's after the last ): ...;
  const match = decl.match(/\):\s*(.+);$/);
  return match ? match[1].trim() : undefined;
}

const moduleForms: ModuleForm[] = modules.map((mod) => {
  const fields: FormField[] = mod.exports.map((exp) => {
    let formKind: FormField["kind"];
    switch (exp.kind) {
      case "function":
        formKind = "action";
        break;
      case "type":
        formKind = "type-descriptor";
        break;
      case "const":
        formKind = "constant";
        break;
      case "interface":
        formKind = "interface";
        break;
      case "class":
        formKind = "class";
        break;
      default:
        formKind = "type-descriptor";
    }
    return {
      name: exp.exportName,
      kind: formKind,
      declaration: exp.declaration,
      sourceFile: exp.source.path,
      sourceLine: exp.source.line,
      ...(exp.kind === "function" ? { parameters: extractParams(exp.declaration) } : {}),
      ...(exp.kind === "function" ? { returnType: extractReturnType(exp.declaration) } : {}),
    };
  });

  return {
    id: mod.entrypoint,
    category: mod.category,
    importSpecifier: mod.importSpecifier,
    fields,
    actionCount: fields.filter((f) => f.kind === "action").length,
    typeCount: fields.filter((f) => f.kind === "type-descriptor").length,
    constCount: fields.filter((f) => f.kind === "constant").length,
  };
});

// ── 6. Similarity matrix (Jaccard on source-file sets) ──
function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : inter.size / union.size;
}

const moduleSourceSets = modules.map((m) => ({
  id: m.entrypoint,
  sources: new Set(m.exports.map((e) => e.source.path)),
}));

const similarityPairs: Array<{ a: string; b: string; jaccard: number; sharedFiles: string[] }> = [];
for (let i = 0; i < moduleSourceSets.length; i++) {
  for (let j = i + 1; j < moduleSourceSets.length; j++) {
    const score = jaccard(moduleSourceSets[i].sources, moduleSourceSets[j].sources);
    if (score > 0) {
      const shared = [...moduleSourceSets[i].sources].filter((s) => moduleSourceSets[j].sources.has(s));
      similarityPairs.push({
        a: moduleSourceSets[i].id,
        b: moduleSourceSets[j].id,
        jaccard: Math.round(score * 1000) / 1000,
        sharedFiles: shared,
      });
    }
  }
}
similarityPairs.sort((a, b) => b.jaccard - a.jaccard);

// ── 7. JSON Web Framework output ──
const framework = {
  name: "openclaw-sdk-form-framework",
  version: "0.1.0",
  description:
    "A JSON-based web framework derived from the OpenClaw plugin SDK API baseline. Each module is represented as a form with typed fields, actions (functions), type descriptors, and constants.",
  generatedFrom: "docs/.generated/plugin-sdk-api-baseline.json",
  analysis: {
    totalModules: modules.length,
    categories: categoryStats,
    sharedSourceFiles: sharedSources,
    sharedExportNames: sharedExports,
    moduleSimilarity: similarityPairs.slice(0, 20),
  },
  forms: moduleForms,
  routing: moduleForms.map((f) => ({
    path: `/${f.category}/${f.id}`,
    formId: f.id,
    importSpecifier: f.importSpecifier,
    actionEndpoints: f.fields
      .filter((field) => field.kind === "action")
      .map((field) => ({
        method: "POST",
        path: `/${f.category}/${f.id}/${field.name}`,
        parameters: field.parameters,
        returnType: field.returnType,
      })),
  })),
};

const outDir = join(__dirname);
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "sdk-form-framework.json"), JSON.stringify(framework, null, 2));
console.log(`✓ Framework written to DataAnalysisExpert/sdk-form-framework.json`);
console.log(`  ${framework.forms.length} forms, ${framework.routing.length} routes`);
console.log(`  Top similarities:`);
for (const p of similarityPairs.slice(0, 5)) {
  console.log(`    ${p.a} ↔ ${p.b}: ${p.jaccard} (${p.sharedFiles.length} shared files)`);
}
