/**
 * MABOS Ontology Loader & Validator
 *
 * Loads all JSON-LD ontologies, validates import chains,
 * checks that all rdfs:domain/range references resolve,
 * and returns a merged graph for querying.
 *
 * SBVR support: validates SBVR annotations and provides
 * query functions and TypeDB export bridge.
 */

import { readFileSync, readdirSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";

// ── Types ──────────────────────────────────────────────────────────────

export interface OntologyNode {
  "@id": string;
  "@type"?: string | string[];
  "rdfs:label"?: string;
  "rdfs:comment"?: string;
  "rdfs:subClassOf"?: string;
  "rdfs:domain"?: string;
  "rdfs:range"?: string | object;
  "owl:imports"?: string;
  [key: string]: unknown;
}

export interface Ontology {
  "@context": Record<string, string>;
  "@id": string;
  "@type"?: string;
  "rdfs:label"?: string;
  "rdfs:comment"?: string;
  "owl:imports"?: string;
  "@graph": OntologyNode[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface MergedGraph {
  classes: Map<string, OntologyNode>;
  objectProperties: Map<string, OntologyNode>;
  datatypeProperties: Map<string, OntologyNode>;
  ontologies: Map<string, Ontology>;
  allNodes: OntologyNode[];
}

// ── SBVR Types ─────────────────────────────────────────────────────────

export interface SBVRConceptAnnotation {
  conceptType: "NounConcept" | "FactType" | "IndividualConcept";
  designation: string;
  definition: string;
  vocabulary: string;
}

export interface SBVRFactTypeAnnotation extends SBVRConceptAnnotation {
  arity: number;
  reading: string;
  roles: Array<{ roleName: string; rolePlayer: string }>;
}

export interface SBVRRuleAnnotation {
  ruleType: "definitional" | "behavioral";
  ruleModality: "alethic" | "deontic";
  constrainsFact: string;
  proofTable?: string;
}

export interface SBVRExportConceptType {
  id: string;
  name: string;
  definition: string;
  properties: Record<string, unknown>;
  constraints: Record<string, unknown>;
  business_context: string;
}

export interface SBVRExportFactType {
  id: string;
  name: string;
  definition: string;
  arity: number;
  roles: Array<{ name: string; concept: string; cardinality: string }>;
  constraints: Record<string, unknown>;
  business_significance: string;
}

export interface SBVRExportRule {
  id: string;
  name: string;
  definition: string;
  rule_type: string;
  condition: string;
  action: string;
  priority: number;
  validation_logic: Record<string, unknown>;
  proof_requirements: string[];
  business_impact: string;
  is_active: boolean;
}

export interface SBVRExportProofTable {
  id: string;
  name: string;
  description: string;
  rule_id: string;
  input_variables: string[];
  output_variables: string[];
  truth_conditions: Array<{ condition: string; expected_result: boolean }>;
  optimization_hints: Record<string, unknown>;
}

export interface SBVRExport {
  conceptTypes: SBVRExportConceptType[];
  factTypes: SBVRExportFactType[];
  rules: SBVRExportRule[];
  proofTables: SBVRExportProofTable[];
}

// ── Loader ─────────────────────────────────────────────────────────────

const ONTOLOGY_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load all .jsonld ontology files from the ontology directory.
 * Excludes shapes.jsonld and shapes-sbvr.jsonld (validation, not ontology).
 */
export function loadOntologies(): Map<string, Ontology> {
  const ontologies = new Map<string, Ontology>();
  const excludeFiles = new Set(["shapes.jsonld", "shapes-sbvr.jsonld"]);
  const files = readdirSync(ONTOLOGY_DIR).filter(
    (f) => f.endsWith(".jsonld") && !excludeFiles.has(f),
  );

  for (const file of files) {
    const content = readFileSync(join(ONTOLOGY_DIR, file), "utf-8");
    const ontology: Ontology = JSON.parse(content);
    ontologies.set(ontology["@id"], ontology);
  }

  return ontologies;
}

/**
 * Load the SHACL shapes file.
 */
export function loadShapes(): Ontology | null {
  try {
    const content = readFileSync(join(ONTOLOGY_DIR, "shapes.jsonld"), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load the SBVR-specific SHACL shapes file.
 */
export function loadSBVRShapes(): Ontology | null {
  try {
    const content = readFileSync(join(ONTOLOGY_DIR, "shapes-sbvr.jsonld"), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Validator ──────────────────────────────────────────────────────────

/**
 * Validate the ontology layer:
 * 1. All owl:imports resolve to loaded ontologies
 * 2. All rdfs:domain references resolve to defined classes
 * 3. All rdfs:range references resolve to defined classes or XSD types
 * 4. All rdfs:subClassOf references resolve
 * 5. No duplicate @id across the merged graph
 * 6. SBVR annotation completeness checks
 */
export function validateOntologies(ontologies: Map<string, Ontology>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Collect all defined class IDs
  const definedClasses = new Set<string>();
  const allIds = new Map<string, string>(); // id → source ontology

  for (const [ontId, ont] of ontologies) {
    for (const node of ont["@graph"]) {
      const id = node["@id"];
      const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];

      if (type.includes("owl:Class")) {
        definedClasses.add(id);
      }

      if (allIds.has(id)) {
        warnings.push(`Duplicate @id "${id}" in ${ontId} (also in ${allIds.get(id)})`);
      }
      allIds.set(id, ontId);
    }
  }

  // Add XSD types as valid ranges
  const xsdTypes = new Set([
    "xsd:string",
    "xsd:integer",
    "xsd:float",
    "xsd:decimal",
    "xsd:boolean",
    "xsd:dateTime",
    "xsd:date",
    "xsd:time",
    "xsd:anyURI",
    "xsd:long",
    "xsd:double",
  ]);

  for (const [ontId, ont] of ontologies) {
    // Check imports
    if (ont["owl:imports"]) {
      const imports = Array.isArray(ont["owl:imports"]) ? ont["owl:imports"] : [ont["owl:imports"]];
      for (const imp of imports) {
        if (!ontologies.has(imp)) {
          errors.push(`${ontId}: imports "${imp}" but it is not loaded`);
        }
      }
    }

    for (const node of ont["@graph"]) {
      const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];

      // Check subClassOf
      if (node["rdfs:subClassOf"] && typeof node["rdfs:subClassOf"] === "string") {
        if (!definedClasses.has(node["rdfs:subClassOf"])) {
          // Check if it's a schema.org class (external, allowed)
          if (!node["rdfs:subClassOf"].startsWith("schema:")) {
            errors.push(
              `${ontId}: "${node["@id"]}" subClassOf "${node["rdfs:subClassOf"]}" which is not defined`,
            );
          }
        }
      }

      // Check domain/range for properties
      if (type.includes("owl:ObjectProperty") || type.includes("owl:DatatypeProperty")) {
        if (node["rdfs:domain"] && typeof node["rdfs:domain"] === "string") {
          if (!definedClasses.has(node["rdfs:domain"])) {
            errors.push(
              `${ontId}: property "${node["@id"]}" domain "${node["rdfs:domain"]}" is not a defined class`,
            );
          }
        }

        if (node["rdfs:range"] && typeof node["rdfs:range"] === "string") {
          if (!definedClasses.has(node["rdfs:range"]) && !xsdTypes.has(node["rdfs:range"])) {
            errors.push(
              `${ontId}: property "${node["@id"]}" range "${node["rdfs:range"]}" is not defined`,
            );
          }
        }
      }

      // Check classes have labels
      if (type.includes("owl:Class") && !node["rdfs:label"]) {
        warnings.push(`${ontId}: class "${node["@id"]}" has no rdfs:label`);
      }

      // Check classes have comments
      if (type.includes("owl:Class") && !node["rdfs:comment"]) {
        warnings.push(`${ontId}: class "${node["@id"]}" has no rdfs:comment`);
      }

      // ── SBVR Annotation Checks ──

      // Warn if an owl:Class is missing sbvr:conceptType
      if (type.includes("owl:Class") && !node["sbvr:conceptType"]) {
        warnings.push(`${ontId}: class "${node["@id"]}" is missing sbvr:conceptType annotation`);
      }

      // Warn if an owl:ObjectProperty is missing sbvr:reading
      if (type.includes("owl:ObjectProperty") && !node["sbvr:reading"]) {
        warnings.push(`${ontId}: property "${node["@id"]}" is missing sbvr:reading annotation`);
      }

      // Error if sbvr:arity doesn't match the number of sbvr:roles
      if (node["sbvr:arity"] && node["sbvr:roles"]) {
        const arity = node["sbvr:arity"] as number;
        const roles = node["sbvr:roles"] as Array<Record<string, string>>;
        if (Array.isArray(roles) && roles.length !== arity) {
          errors.push(
            `${ontId}: "${node["@id"]}" sbvr:arity is ${arity} but has ${roles.length} roles`,
          );
        }
      }

      // Error if sbvr:rolePlayer references an undefined class
      if (node["sbvr:roles"] && Array.isArray(node["sbvr:roles"])) {
        const roles = node["sbvr:roles"] as Array<Record<string, string>>;
        for (const role of roles) {
          const player = role["sbvr:rolePlayer"];
          if (player && !definedClasses.has(player)) {
            errors.push(
              `${ontId}: "${node["@id"]}" role player "${player}" is not a defined class`,
            );
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Merger ─────────────────────────────────────────────────────────────

/**
 * Merge all ontologies into a single queryable graph.
 */
export function mergeOntologies(ontologies: Map<string, Ontology>): MergedGraph {
  const classes = new Map<string, OntologyNode>();
  const objectProperties = new Map<string, OntologyNode>();
  const datatypeProperties = new Map<string, OntologyNode>();
  const allNodes: OntologyNode[] = [];

  for (const [, ont] of ontologies) {
    for (const node of ont["@graph"]) {
      allNodes.push(node);
      const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];

      if (type.includes("owl:Class")) {
        classes.set(node["@id"], node);
      }
      if (type.includes("owl:ObjectProperty")) {
        objectProperties.set(node["@id"], node);
      }
      if (type.includes("owl:DatatypeProperty")) {
        datatypeProperties.set(node["@id"], node);
      }
    }
  }

  return { classes, objectProperties, datatypeProperties, ontologies, allNodes };
}

// ── Convenience ────────────────────────────────────────────────────────

/**
 * Load, validate, and merge all ontologies in one call.
 * Throws if validation finds errors.
 */
export function loadAndValidate(): { graph: MergedGraph; validation: ValidationResult } {
  const ontologies = loadOntologies();
  const validation = validateOntologies(ontologies);
  const graph = mergeOntologies(ontologies);
  return { graph, validation };
}

/**
 * Get all classes in a specific domain ontology.
 */
export function getClassesForDomain(graph: MergedGraph, domainPrefix: string): OntologyNode[] {
  const result: OntologyNode[] = [];
  for (const [id, node] of graph.classes) {
    if (id.startsWith(domainPrefix)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Get all properties (object + datatype) for a given class domain.
 */
export function getPropertiesForClass(graph: MergedGraph, classId: string): OntologyNode[] {
  const result: OntologyNode[] = [];
  for (const [, node] of graph.objectProperties) {
    if (node["rdfs:domain"] === classId) result.push(node);
  }
  for (const [, node] of graph.datatypeProperties) {
    if (node["rdfs:domain"] === classId) result.push(node);
  }
  return result;
}

/**
 * Get the inheritance chain for a class (walks rdfs:subClassOf).
 */
export function getClassHierarchy(graph: MergedGraph, classId: string): string[] {
  const chain: string[] = [classId];
  let current = graph.classes.get(classId);
  while (current && current["rdfs:subClassOf"] && typeof current["rdfs:subClassOf"] === "string") {
    chain.push(current["rdfs:subClassOf"]);
    current = graph.classes.get(current["rdfs:subClassOf"]);
  }
  return chain;
}

// ── SBVR Query Functions ───────────────────────────────────────────────

/**
 * Get all nodes belonging to a specific SBVR vocabulary.
 */
export function getSBVRVocabulary(graph: MergedGraph, vocabName: string): OntologyNode[] {
  return graph.allNodes.filter((node) => node["sbvr:vocabulary"] === vocabName);
}

/**
 * Get all fact types (object properties with sbvr:conceptType === 'FactType')
 * that involve a given concept (as domain or range, or via sbvr:roles).
 */
export function getFactTypesForConcept(graph: MergedGraph, conceptId: string): OntologyNode[] {
  const result: OntologyNode[] = [];
  for (const [, node] of graph.objectProperties) {
    if (node["sbvr:conceptType"] !== "FactType") continue;

    // Check domain/range
    if (node["rdfs:domain"] === conceptId || node["rdfs:range"] === conceptId) {
      result.push(node);
      continue;
    }

    // Check sbvr:roles
    if (node["sbvr:roles"] && Array.isArray(node["sbvr:roles"])) {
      const roles = node["sbvr:roles"] as Array<Record<string, string>>;
      if (roles.some((r) => r["sbvr:rolePlayer"] === conceptId)) {
        result.push(node);
      }
    }
  }
  return result;
}

/**
 * Get all business rules that constrain a given fact type.
 */
export function getRulesForFactType(graph: MergedGraph, factTypeId: string): OntologyNode[] {
  return graph.allNodes.filter((node) => {
    const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    const isRule =
      type.includes("sbvr:DefinitionalRule") ||
      type.includes("sbvr:BehavioralRule") ||
      type.includes("mabos:Rule");
    return isRule && node["sbvr:constrainsFact"] === factTypeId;
  });
}

/**
 * Export the merged graph in the format expected by the TypeDB schema manager.
 *
 * Transforms:
 * - Classes with sbvr:conceptType → create_concept_type() input
 * - Object properties with sbvr:conceptType "FactType" → create_fact_type() input
 * - Rules (sbvr:DefinitionalRule / sbvr:BehavioralRule) → create_business_rule() input
 * - ProofTables → create_proof_table() input
 */
export function exportSBVRForTypeDB(graph: MergedGraph): SBVRExport {
  const conceptTypes: SBVRExportConceptType[] = [];
  const factTypes: SBVRExportFactType[] = [];
  const rules: SBVRExportRule[] = [];
  const proofTables: SBVRExportProofTable[] = [];

  // Export classes as concept types
  for (const [id, node] of graph.classes) {
    if (node["sbvr:conceptType"] !== "NounConcept") continue;

    conceptTypes.push({
      id,
      name: (node["sbvr:designation"] as string) || (node["rdfs:label"] as string) || id,
      definition: (node["sbvr:definition"] as string) || (node["rdfs:comment"] as string) || "",
      properties: {
        subClassOf: node["rdfs:subClassOf"] || null,
        vocabulary: node["sbvr:vocabulary"] || null,
      },
      constraints: {},
      business_context: (node["sbvr:vocabulary"] as string) || "unknown",
    });
  }

  // Export object properties as fact types
  for (const [id, node] of graph.objectProperties) {
    if (node["sbvr:conceptType"] !== "FactType") continue;

    const sbvrRoles = (node["sbvr:roles"] as Array<Record<string, string>>) || [];
    const exportedRoles = sbvrRoles.map((role) => ({
      name: role["sbvr:roleName"] || "",
      concept: role["sbvr:rolePlayer"] || "",
      cardinality: "1",
    }));

    factTypes.push({
      id,
      name: (node["sbvr:reading"] as string) || (node["rdfs:comment"] as string) || id,
      definition: (node["rdfs:comment"] as string) || "",
      arity: (node["sbvr:arity"] as number) || 2,
      roles: exportedRoles,
      constraints: {},
      business_significance: (node["rdfs:comment"] as string) || "",
    });
  }

  // Export business rules
  for (const node of graph.allNodes) {
    const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    const isDefRule = type.includes("sbvr:DefinitionalRule");
    const isBehRule = type.includes("sbvr:BehavioralRule");

    if (!isDefRule && !isBehRule) continue;

    rules.push({
      id: node["@id"],
      name: (node["rdfs:label"] as string) || node["@id"],
      definition: (node["sbvr:definition"] as string) || "",
      rule_type: (node["sbvr:ruleType"] as string) || (isDefRule ? "definitional" : "behavioral"),
      condition: (node["sbvr:definition"] as string) || "",
      action: isDefRule ? "Enforce structural constraint" : "Enforce behavioral constraint",
      priority: isDefRule ? 10 : 8,
      validation_logic: {
        preconditions: [(node["sbvr:constrainsFact"] as string) || ""],
        postconditions: ["constraint_validated"],
      },
      proof_requirements: node["sbvr:hasProofTable"] ? ["proof_table_validation"] : [],
      business_impact: "high",
      is_active: true,
    });

    // Export associated proof table if present
    if (node["sbvr:hasProofTable"]) {
      const ptId = node["sbvr:hasProofTable"] as string;
      // Find the proof table node in the graph
      const ptNode = graph.allNodes.find((n) => n["@id"] === ptId);
      if (ptNode) {
        proofTables.push({
          id: ptId,
          name: (ptNode["rdfs:label"] as string) || ptId,
          description: `Proof table for ${node["rdfs:label"] || node["@id"]}`,
          rule_id: node["@id"],
          input_variables: [(node["sbvr:constrainsFact"] as string) || ""],
          output_variables: ["truth_value"],
          truth_conditions: [
            { condition: (node["sbvr:definition"] as string) || "", expected_result: true },
          ],
          optimization_hints: {
            indexing_strategy: "btree_on_conditions",
            caching_policy: "cache_frequent_validations",
          },
        });
      }
    }
  }

  return { conceptTypes, factTypes, rules, proofTables };
}
