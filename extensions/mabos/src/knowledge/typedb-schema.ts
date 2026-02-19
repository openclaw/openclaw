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
  valueType: "string" | "long" | "double" | "boolean" | "datetime";
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
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Build a TypeQL-safe name from an ontology @id */
function typeqlName(id: string): string {
  return toSnakeCase(stripPrefix(id));
}

// ── XSD → TypeQL Value Type Mapping ─────────────────────────────────────

const XSD_TYPE_MAP: Record<string, TypeQLAttributeDef["valueType"]> = {
  "xsd:string": "string",
  "xsd:integer": "long",
  "xsd:long": "long",
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
export function generateDefineQuery(schema: TypeQLSchema): string {
  const lines: string[] = ["define"];

  // Attributes
  for (const attr of schema.attributes) {
    lines.push(`  ${attr.name} sub attribute, value ${attr.valueType};`);
  }

  if (schema.attributes.length > 0 && schema.entities.length > 0) {
    lines.push("");
  }

  // Entities
  for (const ent of schema.entities) {
    const parent = ent.parent || "entity";
    const ownsClause = ent.owns.length > 0 ? `,\n    owns ${ent.owns.join(",\n    owns ")}` : "";
    lines.push(`  ${ent.name} sub ${parent}${ownsClause};`);
  }

  if (schema.entities.length > 0 && schema.relations.length > 0) {
    lines.push("");
  }

  // Relations
  for (const rel of schema.relations) {
    const rolesClauses = rel.roles.map((r) => `relates ${r.roleName}`).join(",\n    ");
    lines.push(`  ${rel.name} sub relation,\n    ${rolesClauses};`);

    // Add role-playing declarations for entities
    for (const role of rel.roles) {
      lines.push(`  ${role.playerEntity} sub entity, plays ${rel.name}:${role.roleName};`);
    }
  }

  // Agent scoping relation
  lines.push("");
  lines.push("  agent_owns sub relation,");
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
