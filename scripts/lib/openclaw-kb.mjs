/**
 * OpenClaw workspace knowledge_base helpers (ClaWorks ingest scripts).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** content/ subdir → ClaWorks KB namespace */
export const OPENCLAW_KB_NAMESPACE_MAP = {
  product_manual: "products",
  tender_document: "tender",
  other: "company",
  software_copyright: "copyright",
  patent_design: "patents",
  tender_platform: "tender_platform",
  case_study: "cases",
};

export const OPENCLAW_KB_CONTENT_DIRS = Object.keys(OPENCLAW_KB_NAMESPACE_MAP);

/** Default SMB mount path when iMac share is mounted as "Macintosh HD". */
export const DEFAULT_OPENCLAW_KB_MOUNT =
  "/Volumes/Macintosh HD/Users/m/.openclaw/workspace/knowledge_base";

/** iMac canonical path (when accessed on the host itself). */
export const DEFAULT_OPENCLAW_KB_IMAC = "/Users/m/.openclaw/workspace/knowledge_base";

export function resolveOpenclawKbRoot() {
  const fromEnv =
    process.env.CLAWORKS_OPENCLAW_KB_ROOT?.trim() || process.env.OPENCLAW_KB_ROOT?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }
  if (existsSync(DEFAULT_OPENCLAW_KB_MOUNT)) {
    return DEFAULT_OPENCLAW_KB_MOUNT;
  }
  return DEFAULT_OPENCLAW_KB_MOUNT;
}

export function resolveOpenclawKbContentRoot(kbRoot = resolveOpenclawKbRoot()) {
  return join(kbRoot, "content");
}

export function resolveKbCategoryPath(category, kbRoot = resolveOpenclawKbRoot()) {
  return join(kbRoot, "content", category);
}

export function namespaceForCategory(category) {
  return OPENCLAW_KB_NAMESPACE_MAP[category] ?? category;
}

export function resolveBaseUrl() {
  const explicit =
    process.env.CLAWORKS_BASE_URL?.trim() || process.env.CLAWORKS_GATEWAY_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  const port = process.env.CLAWORKS_GATEWAY_PORT?.trim() || "18800";
  return `http://127.0.0.1:${port}`;
}

export function resolveApiKey() {
  const fromEnv = process.env.CLAWORKS_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    join(process.env.CLAWORKS_STATE_DIR?.trim() || join(homedir(), ".claworks"), "claworks.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return config.gateway?.auth?.token?.trim();
  } catch {
    return undefined;
  }
}

export function createKbClient() {
  const base = resolveBaseUrl();
  const apiKey = resolveApiKey();

  async function jfetch(path, init = {}) {
    const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  async function mcpCall(name, args = {}) {
    const body = await jfetch("/v1/mcp/tools/call", {
      method: "POST",
      body: JSON.stringify({ name, arguments: args }),
    });
    const text = body.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }
    return body;
  }

  return { base, apiKey, jfetch, mcpCall };
}

/** Load metadata/file_index.json when present (optional enrich for ingest). */
export function loadFileIndex(kbRoot = resolveOpenclawKbRoot()) {
  const indexPath = join(kbRoot, "metadata", "file_index.json");
  if (!existsSync(indexPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (err) {
    console.warn(
      `[openclaw-kb] file_index.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Convert OpenClaw ontology JSON fragments to OpenAPI components.schemas for bootstrap_from_openapi. */
export function ontologyJsonToOpenApiSchemas(doc) {
  const schemas = {};

  const objectTypes = doc?.object_types ?? doc?.objectTypes ?? doc?.types;
  if (Array.isArray(objectTypes)) {
    for (const ot of objectTypes) {
      const name = String(ot.name ?? ot.type_name ?? "").trim();
      if (!name) {
        continue;
      }
      const fields = ot.fields ?? ot.properties ?? [];
      const props = {};
      const required = [];
      for (const f of fields) {
        const fname = String(f.name ?? f.id ?? "").trim();
        if (!fname) {
          continue;
        }
        props[fname] = { type: mapOntologyFieldType(f.type) };
        if (f.required) {
          required.push(fname);
        }
      }
      schemas[name] = {
        type: "object",
        description: ot.description,
        properties: props,
        ...(required.length ? { required } : {}),
      };
    }
  } else if (objectTypes && typeof objectTypes === "object" && !Array.isArray(objectTypes)) {
    for (const [name, def] of Object.entries(objectTypes)) {
      if (!def || typeof def !== "object") {
        continue;
      }
      const d = /** @type {Record<string, unknown>} */ (def);
      schemas[name] = {
        type: "object",
        description: typeof d.description === "string" ? d.description : undefined,
        properties: d.properties ?? d.fields ?? {},
        ...(Array.isArray(d.required) ? { required: d.required } : {}),
      };
    }
  }

  return schemas;
}

function mapOntologyFieldType(t) {
  const raw = String(t ?? "string").toLowerCase();
  if (raw === "int" || raw === "integer" || raw === "float" || raw === "double") {
    return "number";
  }
  if (raw === "bool" || raw === "boolean") {
    return "boolean";
  }
  return "string";
}

/** Extract entity records grouped by type_name for cw_import_objects. */
export function extractOntologyInstances(doc) {
  const byType = new Map();
  const lists = [doc?.entities, doc?.instances, doc?.objects, doc?.records].filter(Array.isArray);
  for (const list of lists) {
    for (const row of list) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const typeName = String(row.type_name ?? row.type ?? row.object_type ?? "").trim();
      if (!typeName) {
        continue;
      }
      const { type_name: _t, type: _t2, object_type: _t3, ...data } = row;
      const arr = byType.get(typeName) ?? [];
      arr.push(data);
      byType.set(typeName, arr);
    }
  }
  return byType;
}
