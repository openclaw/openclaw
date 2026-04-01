/**
 * TypeDB Schema Converter — JSON-LD / OWL ontology → TypeQL schema
 *
 * Walks the merged ontology graph and produces TypeQL `define` statements
 * for entities (owl:Class), attributes (owl:DatatypeProperty), and
 * relations (owl:ObjectProperty).
 *
 * Replaces the former SBVR export function with TypeQL generation.
 */

import type { MergedGraph, OntologyNode, SBVRExport } from "../ontology/index.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface TypeQLEntityDef {
  name: string;
  parent?: string;
  owns: string[];
}

export interface TypeQLAttributeDef {
  name: string;
  valueType: "string" | "integer" | "double" | "boolean" | "datetime";
}

export interface TypeQLRelationDef {
  name: string;
  roles: Array<{ roleName: string; playerEntity: string }>;
}

export interface TypeQLSchema {
  entities: TypeQLEntityDef[];
  attributes: TypeQLAttributeDef[];
  relations: TypeQLRelationDef[];
}

// ── Naming Helpers ──────────────────────────────────────────────────────

/** Strip namespace prefix (e.g., "mabos:BusinessEntity" → "BusinessEntity") */
function stripPrefix(id: string): string {
  const colonIdx = id.indexOf(":");
  return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
}

/** Convert camelCase/PascalCase to snake_case */
function toSnakeCase(name: string): string {
  return name
    .replace(/\s+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** TypeQL reserved keywords that cannot be used as identifiers */
const TYPEQL_RESERVED = new Set([
  "define",
  "undefine",
  "match",
  "insert",
  "delete",
  "fetch",
  "get",
  "aggregate",
  "group",
  "sort",
  "offset",
  "limit",
  "rule",
  "when",
  "then",
  "type",
  "sub",
  "abstract",
  "owns",
  "relates",
  "plays",
  "value",
  "is",
  "isa",
  "has",
  "not",
  "or",
  "in",
  "contains",
  "like",
  "return",
  "role",
  "thing",
  "entity",
  "relation",
  "attribute",
]);

/** TypeQL primitive value types that cannot play roles */
const TYPEQL_PRIMITIVES = new Set(["string", "integer", "long", "double", "boolean", "datetime"]);

/** Build a TypeQL-safe name from an ontology @id */
function typeqlName(id: string): string {
  const name = toSnakeCase(stripPrefix(id));
  if (TYPEQL_RESERVED.has(name)) return `${name}_entity`;
  return name;
}

// ── XSD → TypeQL Value Type Mapping ─────────────────────────────────────

const XSD_TYPE_MAP: Record<string, TypeQLAttributeDef["valueType"]> = {
  "xsd:string": "string",
  "xsd:integer": "integer",
  "xsd:long": "integer",
  "xsd:float": "double",
  "xsd:double": "double",
  "xsd:decimal": "double",
  "xsd:boolean": "boolean",
  "xsd:dateTime": "datetime",
  "xsd:date": "datetime",
  "xsd:time": "string",
  "xsd:anyURI": "string",
};

function xsdToTypeQL(xsdType: string): TypeQLAttributeDef["valueType"] {
  return XSD_TYPE_MAP[xsdType] || "string";
}

// ── Core Converter ──────────────────────────────────────────────────────

/**
 * Walk the merged ontology graph and produce TypeQL schema definitions.
 */
export function jsonldToTypeQL(graph: MergedGraph): TypeQLSchema {
  const entities: TypeQLEntityDef[] = [];
  const attributes: TypeQLAttributeDef[] = [];
  const relations: TypeQLRelationDef[] = [];
  const attributeNames = new Set<string>();
  const entityNames = new Set<string>();

  // 1. Attributes from owl:DatatypeProperty nodes
  for (const [id, node] of graph.datatypeProperties) {
    const name = typeqlName(id);
    if (attributeNames.has(name)) continue;
    attributeNames.add(name);

    const range = typeof node["rdfs:range"] === "string" ? node["rdfs:range"] : "xsd:string";
    attributes.push({
      name,
      valueType: xsdToTypeQL(range),
    });
  }

  // Always ensure base attributes exist for agent scoping
  for (const base of [
    { name: "name", valueType: "string" as const },
    { name: "description", valueType: "string" as const },
    { name: "uid", valueType: "string" as const },
    { name: "confidence", valueType: "double" as const },
    { name: "created_at", valueType: "datetime" as const },
    { name: "updated_at", valueType: "datetime" as const },
  ]) {
    if (!attributeNames.has(base.name)) {
      attributeNames.add(base.name);
      attributes.push(base);
    }
  }

  // 2. Entities from owl:Class nodes
  for (const [id, node] of graph.classes) {
    const name = typeqlName(id);
    if (entityNames.has(name)) continue;
    entityNames.add(name);

    const parentId =
      typeof node["rdfs:subClassOf"] === "string" ? node["rdfs:subClassOf"] : undefined;
    const parent = parentId ? typeqlName(parentId) : undefined;

    // Collect owned attributes (datatype properties whose domain is this class)
    const owns: string[] = [];
    for (const [propId, propNode] of graph.datatypeProperties) {
      if (propNode["rdfs:domain"] === id) {
        const attrName = typeqlName(propId);
        if (attributeNames.has(attrName)) {
          owns.push(attrName);
        }
      }
    }

    entities.push({ name, parent, owns });
  }

  // 3. Relations from owl:ObjectProperty nodes with sbvr:roles
  for (const [id, node] of graph.objectProperties) {
    const name = typeqlName(id);
    const sbvrRoles = node["sbvr:roles"] as Array<Record<string, string>> | undefined;

    if (sbvrRoles && Array.isArray(sbvrRoles) && sbvrRoles.length > 0) {
      const roles = sbvrRoles.map((role) => ({
        roleName: typeqlName(role["sbvr:roleName"] || "participant"),
        playerEntity: typeqlName(role["sbvr:rolePlayer"] || "entity"),
      }));
      relations.push({ name, roles });
    } else {
      // Fallback: use domain/range as two roles
      const domain =
        typeof node["rdfs:domain"] === "string" ? typeqlName(node["rdfs:domain"]) : "entity";
      const range =
        typeof node["rdfs:range"] === "string" ? typeqlName(node["rdfs:range"]) : "entity";
      relations.push({
        name,
        roles: [
          { roleName: "subject", playerEntity: domain },
          { roleName: "object", playerEntity: range },
        ],
      });
    }
  }

  return { entities, attributes, relations };
}

// ── TypeQL Generation ───────────────────────────────────────────────────

/**
 * Concatenate schema definitions into a single TypeQL `define` block.
 */
/** Extract attribute names from a TypeQL define block */
function extractBaseSchemaAttrs(baseSchema: string): Set<string> {
  const attrs = new Set<string>();
  const re = /attribute\s+([a-z_][a-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(baseSchema)) !== null) {
    attrs.add(m[1]);
  }
  return attrs;
}

/**
 * Resolve name collisions: TypeQL requires unique labels across all type kinds.
 * Returns a renaming map (oldName -> newName) for entities and relations that
 * collide with attribute names (from ontology or base schema).
 */
function resolveCollisions(
  schema: TypeQLSchema,
  baseSchemaAttrs?: Set<string>,
): Map<string, string> {
  const attrNames = new Set(schema.attributes.map((a) => a.name));
  // Also include base schema attribute names to avoid cross-schema collisions
  if (baseSchemaAttrs) {
    for (const n of baseSchemaAttrs) attrNames.add(n);
  }

  const renames = new Map<string, string>();
  const allUsed = new Set(attrNames);

  for (const ent of schema.entities) {
    if (allUsed.has(ent.name)) {
      const newName = `${ent.name}_type`;
      renames.set(ent.name, newName);
      allUsed.add(newName);
    } else {
      allUsed.add(ent.name);
    }
  }

  for (const rel of schema.relations) {
    if (allUsed.has(rel.name)) {
      const newName = `${rel.name}_rel`;
      renames.set(rel.name, newName);
      allUsed.add(newName);
    } else {
      allUsed.add(rel.name);
    }
  }

  return renames;
}

/** Apply rename map to a name */
function renamed(name: string, renames: Map<string, string>): string {
  return renames.get(name) ?? name;
}

export function generateDefineQuery(schema: TypeQLSchema, baseSchema?: string): string {
  const baseAttrs = baseSchema ? extractBaseSchemaAttrs(baseSchema) : undefined;
  const renames = resolveCollisions(schema, baseAttrs);
  const lines: string[] = ["define"];

  // Attributes — TypeQL 3.x: `attribute <name>, value <type>;`
  // Skip attributes already defined in base schema to avoid type conflicts
  const baseAttrsToSkip = baseAttrs ?? new Set<string>();
  for (const attr of schema.attributes) {
    if (baseAttrsToSkip.has(attr.name)) continue;
    lines.push(`  attribute ${attr.name}, value ${attr.valueType};`);
  }

  if (schema.attributes.length > 0 && schema.entities.length > 0) {
    lines.push("");
  }

  // Entities — TypeQL 3.x: `entity <name> ...;` (use `sub` only for subtypes)
  // Extract base schema entity names — skip them entirely (already defined)
  const baseEntityNames = new Set<string>();
  if (baseSchema) {
    const entityRe = /entity\s+([a-z_][a-z0-9_]*)/g;
    let em: RegExpExecArray | null;
    while ((em = entityRe.exec(baseSchema)) !== null) {
      baseEntityNames.add(em[1]);
    }
  }
  const allEntityNames = new Set(schema.entities.map((e) => renamed(e.name, renames)));
  for (const n of baseEntityNames) allEntityNames.add(n);

  // Also extract base schema relation names to skip
  const baseRelNames = new Set<string>();
  if (baseSchema) {
    const relRe = /relation\s+([a-z_][a-z0-9_]*)/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(baseSchema)) !== null) {
      baseRelNames.add(rm[1]);
    }
  }

  for (const ent of schema.entities) {
    const name = renamed(ent.name, renames);
    // Skip entities already defined in the base schema
    if (baseEntityNames.has(name)) continue;
    const parent = ent.parent ? renamed(ent.parent, renames) : undefined;
    // Skip sub clause if parent is self-reference or not defined in any schema
    const validParent =
      parent && parent !== name && allEntityNames.has(parent) ? parent : undefined;
    // Also skip sub clause if parent is a base schema entity (can't add sub to existing types)
    const safeParent = validParent && !baseEntityNames.has(validParent) ? validParent : undefined;
    const subClause = safeParent ? ` sub ${safeParent}` : "";
    // Skip owns for base-schema-only attrs
    const validOwns = ent.owns.filter((a) => !baseAttrsToSkip.has(a));
    const ownsClause = validOwns.length > 0 ? `,\n    owns ${validOwns.join(",\n    owns ")}` : "";
    lines.push(`  entity ${name}${subClause}${ownsClause};`);
  }

  if (schema.entities.length > 0 && schema.relations.length > 0) {
    lines.push("");
  }

  // Relations — TypeQL 3.x: `relation <name>, relates ...;`
  for (const rel of schema.relations) {
    const relName = renamed(rel.name, renames);
    // Skip relations already in base schema
    if (baseRelNames.has(relName)) continue;
    const rolesClauses = rel.roles.map((r) => `relates ${r.roleName}`).join(",\n    ");
    lines.push(`  relation ${relName},\n    ${rolesClauses};`);

    // Add role-playing declarations for entities
    // Skip primitive types, undefined entities, and base schema entities (already configured)
    for (const role of rel.roles) {
      const playerName = renamed(role.playerEntity, renames);
      if (TYPEQL_PRIMITIVES.has(playerName)) continue;
      if (!allEntityNames.has(playerName)) continue;
      if (baseEntityNames.has(playerName)) continue;
      lines.push(`  ${playerName} plays ${relName}:${role.roleName};`);
    }
  }

  // Agent scoping relation
  lines.push("");
  lines.push("  relation agent_owns,");
  lines.push("    relates owner,");
  lines.push("    relates owned;");

  return lines.join("\n");
}

// ── SBVR Export Replacement ─────────────────────────────────────────────

/**
 * Export SBVR data for TypeDB. Returns the original SBVRExport format
 * plus the generated TypeQL schema string.
 */
export function exportSBVRForTypeDB(
  graph: MergedGraph,
  sbvrExport: SBVRExport,
): SBVRExport & { typeql: string } {
  const schema = jsonldToTypeQL(graph);
  const typeql = generateDefineQuery(schema);
  return { ...sbvrExport, typeql };
}
