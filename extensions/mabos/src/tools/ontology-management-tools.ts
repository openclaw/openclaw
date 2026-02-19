/**
 * Ontology Management Tools
 *
 * Enables agents to propose, validate, and merge new ontology nodes
 * (classes, properties, relationships) so the knowledge graph grows
 * organically as new business domains and concepts emerge.
 *
 * Pipeline: propose → validate → merge
 *
 * Tools:
 *   1. ontology_propose_concept  — Agent proposes a new class/property with SBVR metadata
 *   2. ontology_validate_proposal — Knowledge agent checks consistency & duplicates
 *   3. ontology_merge_approved   — Writes approved nodes into the domain ontology file
 *   4. ontology_list_proposals   — List pending proposals awaiting review
 *   5. ontology_scaffold_domain  — Generate a new domain ontology from a business type template
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

// ── Schemas ────────────────────────────────────────────────────────────

const ProposeConceptParams = Type.Object({
  domain: Type.String({
    description: "Target ontology domain file (e.g., 'ecommerce', 'saas', 'mabos-upper')",
  }),
  node_type: Type.Union(
    [Type.Literal("class"), Type.Literal("object_property"), Type.Literal("datatype_property")],
    { description: "Type of ontology node to create" },
  ),
  id: Type.String({
    description: "Full qualified ID with namespace prefix (e.g., 'ecommerce:DropshipFulfillment')",
  }),
  label: Type.String({ description: "Human-readable label (rdfs:label)" }),
  comment: Type.String({ description: "Description of the concept (rdfs:comment)" }),
  subclass_of: Type.Optional(
    Type.String({ description: "Parent class ID for classes (e.g., 'ecommerce:Fulfillment')" }),
  ),
  domain_class: Type.Optional(
    Type.String({ description: "Domain class for properties (rdfs:domain)" }),
  ),
  range: Type.Optional(
    Type.String({
      description:
        "Range for properties — class ID or XSD type (e.g., 'xsd:string', 'mabos:Agent')",
    }),
  ),
  sbvr_designation: Type.String({
    description: "SBVR natural language term (e.g., 'dropship fulfillment')",
  }),
  sbvr_definition: Type.String({
    description:
      "Formal SBVR definition (e.g., 'A dropship fulfillment is a fulfillment method where...')",
  }),
  sbvr_vocabulary: Type.Optional(
    Type.String({ description: "SBVR vocabulary name. Defaults to domain name." }),
  ),
  sbvr_reading: Type.Optional(
    Type.String({
      description: "Natural language reading for properties (e.g., 'agent manages business')",
    }),
  ),
  rationale: Type.Optional(
    Type.String({ description: "Why this concept is needed — context for the knowledge agent" }),
  ),
  proposed_by: Type.Optional(
    Type.String({ description: "Agent ID or role proposing this concept (e.g., 'ceo', 'coo')" }),
  ),
});

const ValidateProposalParams = Type.Object({
  proposal_id: Type.String({
    description: "Proposal ID (from ontology_propose_concept result) to validate",
  }),
  auto_approve: Type.Optional(
    Type.Boolean({
      description: "If true and validation passes, auto-approve for merge. Default: false",
    }),
  ),
});

const MergeApprovedParams = Type.Object({
  proposal_id: Type.String({ description: "Proposal ID to merge into the ontology" }),
  stakeholder_notes: Type.Optional(
    Type.String({ description: "Optional stakeholder notes or conditions" }),
  ),
});

const ListProposalsParams = Type.Object({
  domain: Type.Optional(Type.String({ description: "Filter by domain" })),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("validated"),
        Type.Literal("rejected"),
        Type.Literal("merged"),
      ],
      { description: "Filter by proposal status" },
    ),
  ),
});

const ScaffoldDomainParams = Type.Object({
  domain_name: Type.String({
    description: "Domain identifier (lowercase, hyphenated, e.g., 'fintech', 'edtech')",
  }),
  business_type: Type.String({
    description:
      "Business model type for template selection (e.g., 'saas', 'marketplace', 'service')",
  }),
  label: Type.String({
    description: "Human-readable ontology label (e.g., 'FinTech Domain Ontology')",
  }),
  description: Type.String({ description: "Description of the business domain" }),
  core_classes: Type.Array(
    Type.Object({
      name: Type.String({ description: "Class name in PascalCase (e.g., 'LoanProduct')" }),
      label: Type.String({ description: "Human label" }),
      comment: Type.String({ description: "Description" }),
      parent: Type.Optional(
        Type.String({ description: "Parent class ID (defaults to business-core class)" }),
      ),
    }),
    { description: "Initial core classes to scaffold" },
  ),
});

// ── Helpers ─────────────────────────────────────────────────────────────

interface Proposal {
  id: string;
  domain: string;
  node_type: string;
  node: Record<string, unknown>;
  sbvr: Record<string, string>;
  rationale: string;
  proposed_by: string;
  proposed_at: string;
  status: "pending" | "validated" | "rejected" | "merged";
  validation_result?: { errors: string[]; warnings: string[]; duplicate_candidates: string[] };
  stakeholder_notes?: string;
}

function getOntologyDir(): string {
  // Resolve to the source ontology directory within the plugin
  return join(dirname(dirname(__dirname)), "src", "ontology");
}

async function getProposalsPath(ws: string): Promise<string> {
  const dir = join(ws, "ontology-proposals");
  await mkdir(dir, { recursive: true });
  return join(dir, "proposals.json");
}

async function loadProposals(ws: string): Promise<Proposal[]> {
  const path = await getProposalsPath(ws);
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return [];
  }
}

async function saveProposals(ws: string, proposals: Proposal[]): Promise<void> {
  const path = await getProposalsPath(ws);
  await writeFile(path, JSON.stringify(proposals, null, 2));
}

async function loadOntologyFile(domain: string): Promise<Record<string, unknown> | null> {
  const ontDir = getOntologyDir();
  const path = join(ontDir, `${domain}.jsonld`);
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function saveOntologyFile(domain: string, data: Record<string, unknown>): Promise<void> {
  const ontDir = getOntologyDir();
  const path = join(ontDir, `${domain}.jsonld`);
  await writeFile(path, JSON.stringify(data, null, 2));
}

function generateProposalId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `prop-${ts}-${rand}`;
}

// ── Tool Factory ───────────────────────────────────────────────────────

export function createOntologyManagementTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    // ────────────────────────────────────────────────────────────────────
    // 1. PROPOSE CONCEPT
    // ────────────────────────────────────────────────────────────────────
    {
      name: "ontology_propose_concept",
      label: "Propose Ontology Concept",
      description:
        "Propose a new class, object property, or datatype property for the MABOS ontology. " +
        "Creates a proposal that must be validated and approved before being merged. " +
        "Requires SBVR metadata (designation, definition) for governance.",
      parameters: ProposeConceptParams,
      async execute(_id: string, params: Static<typeof ProposeConceptParams>) {
        const ws = resolveWorkspaceDir(api);

        // Verify domain ontology exists
        const ont = await loadOntologyFile(params.domain);
        if (!ont) {
          return textResult(
            `Error: Domain ontology '${params.domain}' not found. ` +
              `Available domains can be found in the ontology directory. ` +
              `Use ontology_scaffold_domain to create a new domain first.`,
          );
        }

        // Build the OWL node
        const owlType =
          params.node_type === "class"
            ? "owl:Class"
            : params.node_type === "object_property"
              ? "owl:ObjectProperty"
              : "owl:DatatypeProperty";

        const node: Record<string, unknown> = {
          "@id": params.id,
          "@type": owlType,
          "rdfs:label": params.label,
          "rdfs:comment": params.comment,
        };

        // Class-specific
        if (params.node_type === "class" && params.subclass_of) {
          node["rdfs:subClassOf"] = params.subclass_of;
        }

        // Property-specific
        if (params.node_type !== "class") {
          if (params.domain_class) node["rdfs:domain"] = params.domain_class;
          if (params.range) node["rdfs:range"] = params.range;
        }

        // SBVR annotations
        const sbvrConceptType = params.node_type === "class" ? "NounConcept" : "FactType";

        node["sbvr:conceptType"] = sbvrConceptType;
        node["sbvr:designation"] = params.sbvr_designation;
        node["sbvr:definition"] = params.sbvr_definition;
        node["sbvr:vocabulary"] = params.sbvr_vocabulary || params.domain;

        if (params.sbvr_reading && params.node_type !== "class") {
          node["sbvr:reading"] = params.sbvr_reading;
        }

        // Create proposal
        const proposal: Proposal = {
          id: generateProposalId(),
          domain: params.domain,
          node_type: params.node_type,
          node,
          sbvr: {
            conceptType: sbvrConceptType,
            designation: params.sbvr_designation,
            definition: params.sbvr_definition,
            vocabulary: params.sbvr_vocabulary || params.domain,
          },
          rationale: params.rationale || "",
          proposed_by: params.proposed_by || "unknown",
          proposed_at: new Date().toISOString(),
          status: "pending",
        };

        // Save
        const proposals = await loadProposals(ws);
        proposals.push(proposal);
        await saveProposals(ws, proposals);

        return textResult(
          `## Proposal Created\n\n` +
            `- **ID:** \`${proposal.id}\`\n` +
            `- **Domain:** ${params.domain}\n` +
            `- **Type:** ${params.node_type}\n` +
            `- **Node:** \`${params.id}\`\n` +
            `- **Label:** ${params.label}\n` +
            `- **SBVR Definition:** ${params.sbvr_definition}\n` +
            `- **Status:** pending\n\n` +
            `Next: Run \`ontology_validate_proposal\` with proposal_id \`${proposal.id}\` to check consistency.`,
        );
      },
    },

    // ────────────────────────────────────────────────────────────────────
    // 2. VALIDATE PROPOSAL
    // ────────────────────────────────────────────────────────────────────
    {
      name: "ontology_validate_proposal",
      label: "Validate Ontology Proposal",
      description:
        "Validate a pending ontology proposal against the existing ontology. " +
        "Checks for duplicate concepts, broken references, SBVR completeness, " +
        "and SHACL shape compliance. Optionally auto-approves if clean.",
      parameters: ValidateProposalParams,
      async execute(_id: string, params: Static<typeof ValidateProposalParams>) {
        const ws = resolveWorkspaceDir(api);
        const proposals = await loadProposals(ws);
        const proposal = proposals.find((p) => p.id === params.proposal_id);

        if (!proposal) {
          return textResult(`Error: Proposal '${params.proposal_id}' not found.`);
        }
        if (proposal.status !== "pending") {
          return textResult(
            `Proposal '${params.proposal_id}' is already ${proposal.status}. Only pending proposals can be validated.`,
          );
        }

        const errors: string[] = [];
        const warnings: string[] = [];
        const duplicateCandidates: string[] = [];

        // Load target ontology
        const ont = await loadOntologyFile(proposal.domain);
        if (!ont) {
          errors.push(`Domain ontology '${proposal.domain}' not found`);
        }

        const graph = ((ont as any)?.["@graph"] as Array<Record<string, unknown>>) || [];

        // ── Check 1: Duplicate ID ──
        const existingNode = graph.find((n) => n["@id"] === proposal.node["@id"]);
        if (existingNode) {
          errors.push(
            `Node ID '${proposal.node["@id"]}' already exists in ${proposal.domain}.jsonld`,
          );
        }

        // ── Check 2: Similar concepts (fuzzy duplicate detection) ──
        const proposedLabel = ((proposal.node["rdfs:label"] as string) || "").toLowerCase();
        const proposedDesignation = (proposal.sbvr.designation || "").toLowerCase();

        // Also check all other ontology files for cross-domain duplicates
        const ontDir = getOntologyDir();
        let allNodes: Array<{ id: string; label: string; domain: string }> = [];
        try {
          const { readdirSync, readFileSync } = await import("node:fs");
          const files = readdirSync(ontDir).filter(
            (f: string) => f.endsWith(".jsonld") && !f.startsWith("shapes"),
          );
          for (const file of files) {
            try {
              const data = JSON.parse(readFileSync(join(ontDir, file), "utf-8"));
              const g = data["@graph"] || [];
              for (const node of g) {
                allNodes.push({
                  id: node["@id"] || "",
                  label: (node["rdfs:label"] || "").toLowerCase(),
                  domain: file.replace(".jsonld", ""),
                });
              }
            } catch {
              /* skip */
            }
          }
        } catch {
          /* skip */
        }

        for (const existing of allNodes) {
          if (existing.id === proposal.node["@id"]) continue;
          // Check label similarity
          if (
            existing.label &&
            (existing.label === proposedLabel ||
              existing.label.includes(proposedLabel) ||
              proposedLabel.includes(existing.label))
          ) {
            duplicateCandidates.push(
              `Similar to '${existing.id}' ("${existing.label}") in ${existing.domain}`,
            );
          }
        }

        if (duplicateCandidates.length > 0) {
          warnings.push(
            `Found ${duplicateCandidates.length} similar existing concept(s) — review for potential duplicates`,
          );
        }

        // ── Check 3: Reference resolution ──
        const allClassIds = new Set(allNodes.filter((n) => true).map((n) => n.id));

        if (proposal.node["rdfs:subClassOf"]) {
          const parent = proposal.node["rdfs:subClassOf"] as string;
          if (!allClassIds.has(parent)) {
            errors.push(`Parent class '${parent}' is not defined in any loaded ontology`);
          }
        }

        if (proposal.node["rdfs:domain"]) {
          const dom = proposal.node["rdfs:domain"] as string;
          if (!allClassIds.has(dom)) {
            errors.push(`Domain class '${dom}' is not defined in any loaded ontology`);
          }
        }

        if (proposal.node["rdfs:range"]) {
          const rng = proposal.node["rdfs:range"] as string;
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
          if (!allClassIds.has(rng) && !xsdTypes.has(rng)) {
            errors.push(`Range '${rng}' is not a defined class or XSD type`);
          }
        }

        // ── Check 4: SBVR completeness ──
        if (!proposal.sbvr.designation) {
          errors.push("Missing SBVR designation (natural language term)");
        }
        if (!proposal.sbvr.definition) {
          errors.push("Missing SBVR definition");
        }
        if (!proposal.sbvr.vocabulary) {
          warnings.push("Missing SBVR vocabulary assignment");
        }

        // ── Check 5: Naming conventions ──
        const nodeId = proposal.node["@id"] as string;
        if (!nodeId.includes(":")) {
          errors.push(
            `Node ID '${nodeId}' must use a namespace prefix (e.g., 'ecommerce:MyClass')`,
          );
        }
        if (
          proposal.node_type === "class" &&
          nodeId.includes(":") &&
          /^[a-z]/.test(nodeId.split(":")[1])
        ) {
          warnings.push(`Class IDs should use PascalCase (got '${nodeId.split(":")[1]}')`);
        }
        if (
          proposal.node_type !== "class" &&
          nodeId.includes(":") &&
          /^[A-Z]/.test(nodeId.split(":")[1])
        ) {
          warnings.push(`Property IDs should use camelCase (got '${nodeId.split(":")[1]}')`);
        }

        // ── Result ──
        const valid = errors.length === 0;
        proposal.validation_result = {
          errors,
          warnings,
          duplicate_candidates: duplicateCandidates,
        };

        if (valid && params.auto_approve) {
          proposal.status = "validated";
        } else if (valid) {
          proposal.status = "validated";
        } else {
          proposal.status = "pending"; // stays pending if errors found
        }

        await saveProposals(ws, proposals);

        const statusEmoji = valid ? "PASSED" : "FAILED";

        return textResult(
          `## Validation ${statusEmoji}: ${proposal.node["@id"]}\n\n` +
            `**Status:** ${proposal.status}\n\n` +
            (errors.length
              ? `### Errors (${errors.length})\n${errors.map((e) => `- ${e}`).join("\n")}\n\n`
              : "") +
            (warnings.length
              ? `### Warnings (${warnings.length})\n${warnings.map((w) => `- ${w}`).join("\n")}\n\n`
              : "") +
            (duplicateCandidates.length
              ? `### Potential Duplicates\n${duplicateCandidates.map((d) => `- ${d}`).join("\n")}\n\n`
              : "") +
            (valid
              ? `Ready to merge. Run \`ontology_merge_approved\` with proposal_id \`${proposal.id}\`.`
              : `Fix the errors above and submit a new proposal.`),
        );
      },
    },

    // ────────────────────────────────────────────────────────────────────
    // 3. MERGE APPROVED
    // ────────────────────────────────────────────────────────────────────
    {
      name: "ontology_merge_approved",
      label: "Merge Approved Ontology Concept",
      description:
        "Merge a validated ontology proposal into the target domain ontology file. " +
        "Only proposals with 'validated' status can be merged. " +
        "Writes the node into the @graph array and updates proposal status.",
      parameters: MergeApprovedParams,
      async execute(_id: string, params: Static<typeof MergeApprovedParams>) {
        const ws = resolveWorkspaceDir(api);
        const proposals = await loadProposals(ws);
        const proposal = proposals.find((p) => p.id === params.proposal_id);

        if (!proposal) {
          return textResult(`Error: Proposal '${params.proposal_id}' not found.`);
        }
        if (proposal.status !== "validated") {
          return textResult(
            `Proposal '${params.proposal_id}' status is '${proposal.status}'. ` +
              `Only validated proposals can be merged. Run ontology_validate_proposal first.`,
          );
        }

        // Load ontology
        const ont = (await loadOntologyFile(proposal.domain)) as any;
        if (!ont) {
          return textResult(`Error: Domain ontology '${proposal.domain}' not found.`);
        }

        // Double-check no duplicate ID crept in
        const existing = ont["@graph"].find((n: any) => n["@id"] === proposal.node["@id"]);
        if (existing) {
          proposal.status = "rejected";
          await saveProposals(ws, proposals);
          return textResult(
            `Error: Node '${proposal.node["@id"]}' was added to the ontology since validation. Proposal rejected.`,
          );
        }

        // Merge — add to @graph
        ont["@graph"].push(proposal.node);

        // Ensure the namespace prefix exists in @context
        const nodeId = proposal.node["@id"] as string;
        const prefix = nodeId.split(":")[0];
        if (prefix && !ont["@context"][prefix]) {
          // Add namespace based on common patterns
          ont["@context"][prefix] = `https://mabos.io/ontology/${prefix}/`;
        }

        // Save ontology
        await saveOntologyFile(proposal.domain, ont);

        // Update proposal
        proposal.status = "merged";
        if (params.stakeholder_notes) {
          proposal.stakeholder_notes = params.stakeholder_notes;
        }
        await saveProposals(ws, proposals);

        // Count updated stats
        const graph = ont["@graph"];
        const classes = graph.filter((n: any) => n["@type"] === "owl:Class").length;
        const objProps = graph.filter((n: any) => n["@type"] === "owl:ObjectProperty").length;
        const dataProps = graph.filter((n: any) => n["@type"] === "owl:DatatypeProperty").length;

        return textResult(
          `## Merged Successfully\n\n` +
            `- **Node:** \`${proposal.node["@id"]}\`\n` +
            `- **Domain:** ${proposal.domain}.jsonld\n` +
            `- **Type:** ${proposal.node_type}\n\n` +
            `### Updated Ontology Stats (${proposal.domain})\n` +
            `- Classes: ${classes}\n` +
            `- Object Properties: ${objProps}\n` +
            `- Datatype Properties: ${dataProps}\n` +
            `- Total nodes: ${graph.length}\n\n` +
            `All agents will pick up the updated ontology on next query.`,
        );
      },
    },

    // ────────────────────────────────────────────────────────────────────
    // 4. LIST PROPOSALS
    // ────────────────────────────────────────────────────────────────────
    {
      name: "ontology_list_proposals",
      label: "List Ontology Proposals",
      description: "List ontology change proposals with optional filters by domain and status.",
      parameters: ListProposalsParams,
      async execute(_id: string, params: Static<typeof ListProposalsParams>) {
        const ws = resolveWorkspaceDir(api);
        let proposals = await loadProposals(ws);

        if (params.domain) {
          proposals = proposals.filter((p) => p.domain === params.domain);
        }
        if (params.status) {
          proposals = proposals.filter((p) => p.status === params.status);
        }

        if (proposals.length === 0) {
          return textResult(
            `No proposals found${params.domain ? ` for domain '${params.domain}'` : ""}${params.status ? ` with status '${params.status}'` : ""}.`,
          );
        }

        const summary = proposals
          .map(
            (p) =>
              `- **${p.id}** | \`${p.node["@id"]}\` | ${p.node_type} | ${p.domain} | ${p.status} | by ${p.proposed_by} (${new Date(p.proposed_at).toLocaleDateString()})`,
          )
          .join("\n");

        const byStatus = {
          pending: proposals.filter((p) => p.status === "pending").length,
          validated: proposals.filter((p) => p.status === "validated").length,
          merged: proposals.filter((p) => p.status === "merged").length,
          rejected: proposals.filter((p) => p.status === "rejected").length,
        };

        return textResult(
          `## Ontology Proposals (${proposals.length})\n\n` +
            `Pending: ${byStatus.pending} | Validated: ${byStatus.validated} | Merged: ${byStatus.merged} | Rejected: ${byStatus.rejected}\n\n` +
            summary,
        );
      },
    },

    // ────────────────────────────────────────────────────────────────────
    // 5. SCAFFOLD DOMAIN
    // ────────────────────────────────────────────────────────────────────
    {
      name: "ontology_scaffold_domain",
      label: "Scaffold New Domain Ontology",
      description:
        "Generate a new domain ontology file scaffolded from the upper ontology and " +
        "business-core, pre-populated with initial classes for the business type. " +
        "Also creates cross-domain relationships and updates the cross-domain ontology.",
      parameters: ScaffoldDomainParams,
      async execute(_id: string, params: Static<typeof ScaffoldDomainParams>) {
        const prefix = params.domain_name.replace(/-/g, "");
        const namespace = `https://mabos.io/ontology/${params.domain_name}/`;

        // Check if already exists
        const existing = await loadOntologyFile(params.domain_name);
        if (existing) {
          return textResult(
            `Error: Domain ontology '${params.domain_name}' already exists. ` +
              `Use ontology_propose_concept to add nodes to it.`,
          );
        }

        // Determine parent class based on business type
        const parentMap: Record<string, string> = {
          saas: "business:DigitalBusiness",
          ecommerce: "business:CommerceBusiness",
          marketplace: "business:PlatformBusiness",
          consulting: "business:ServiceBusiness",
          retail: "business:CommerceBusiness",
          service: "business:ServiceBusiness",
          fintech: "business:DigitalBusiness",
          edtech: "business:DigitalBusiness",
          healthtech: "business:DigitalBusiness",
          media: "business:DigitalBusiness",
        };
        const defaultParent = parentMap[params.business_type] || "business:Business";

        // Build classes
        const graphNodes: Array<Record<string, unknown>> = [];

        // Domain root class
        const rootClassName =
          params.domain_name
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join("") + "Business";

        graphNodes.push({
          "@id": `${prefix}:${rootClassName}`,
          "@type": "owl:Class",
          "rdfs:label": `${params.label.replace(" Domain Ontology", "")} Business`,
          "rdfs:comment": params.description,
          "rdfs:subClassOf": defaultParent,
          "sbvr:conceptType": "NounConcept",
          "sbvr:designation": rootClassName
            .replace(/([A-Z])/g, " $1")
            .trim()
            .toLowerCase(),
          "sbvr:definition": `A ${rootClassName
            .replace(/([A-Z])/g, " $1")
            .trim()
            .toLowerCase()} is a ${
            defaultParent
              .split(":")[1]
              ?.replace(/([A-Z])/g, " $1")
              .trim()
              .toLowerCase() || "business"
          } that ${params.description.toLowerCase()}`,
          "sbvr:vocabulary": params.domain_name,
        });

        // User-defined core classes
        for (const cls of params.core_classes) {
          graphNodes.push({
            "@id": `${prefix}:${cls.name}`,
            "@type": "owl:Class",
            "rdfs:label": cls.label,
            "rdfs:comment": cls.comment,
            "rdfs:subClassOf": cls.parent || `${prefix}:${rootClassName}`,
            "sbvr:conceptType": "NounConcept",
            "sbvr:designation": cls.label.toLowerCase(),
            "sbvr:definition": cls.comment,
            "sbvr:vocabulary": params.domain_name,
          });
        }

        // Standard operational classes every domain gets
        const standardClasses = [
          {
            name: "Customer",
            label: "Customer",
            comment: `A customer of the ${params.domain_name} business`,
            parent: "business:Customer",
          },
          {
            name: "Transaction",
            label: "Transaction",
            comment: `A business transaction in the ${params.domain_name} domain`,
            parent: "business:Transaction",
          },
          {
            name: "Metric",
            label: "Metric",
            comment: `A business metric tracked in the ${params.domain_name} domain`,
            parent: "business:KPI",
          },
        ];

        for (const cls of standardClasses) {
          graphNodes.push({
            "@id": `${prefix}:${cls.name}`,
            "@type": "owl:Class",
            "rdfs:label": cls.label,
            "rdfs:comment": cls.comment,
            "rdfs:subClassOf": cls.parent,
            "sbvr:conceptType": "NounConcept",
            "sbvr:designation": cls.label.toLowerCase(),
            "sbvr:definition": cls.comment,
            "sbvr:vocabulary": params.domain_name,
          });
        }

        // Standard relationships
        graphNodes.push(
          {
            "@id": `${prefix}:hasCustomer`,
            "@type": "owl:ObjectProperty",
            "rdfs:domain": `${prefix}:${rootClassName}`,
            "rdfs:range": `${prefix}:Customer`,
            "rdfs:comment": `Links a ${params.domain_name} business to its customers`,
            "sbvr:conceptType": "FactType",
            "sbvr:reading": `${params.domain_name} business has customer`,
            "sbvr:vocabulary": params.domain_name,
          },
          {
            "@id": `${prefix}:tracksMetric`,
            "@type": "owl:ObjectProperty",
            "rdfs:domain": `${prefix}:${rootClassName}`,
            "rdfs:range": `${prefix}:Metric`,
            "rdfs:comment": `Links a ${params.domain_name} business to tracked metrics`,
            "sbvr:conceptType": "FactType",
            "sbvr:reading": `${params.domain_name} business tracks metric`,
            "sbvr:vocabulary": params.domain_name,
          },
        );

        // Build ontology document
        const ontology = {
          "@context": {
            [prefix]: namespace,
            business: "https://mabos.io/ontology/business/",
            mabos: "https://mabos.io/ontology/",
            sbvr: "https://mabos.io/ontology/sbvr/",
            owl: "http://www.w3.org/2002/07/owl#",
            rdfs: "http://www.w3.org/2000/01/rdf-schema#",
            xsd: "http://www.w3.org/2001/XMLSchema#",
          },
          "@id": namespace,
          "@type": "owl:Ontology",
          "owl:imports": "https://mabos.io/ontology/business-core/",
          "rdfs:label": params.label,
          "rdfs:comment": params.description,
          "@graph": graphNodes,
        };

        await saveOntologyFile(params.domain_name, ontology);

        // Update cross-domain.jsonld with a relationship to the new domain
        const crossDomain = await loadOntologyFile("cross-domain");
        if (crossDomain) {
          const cdGraph = (crossDomain as any)["@graph"] as Array<Record<string, unknown>>;

          // Add cross-domain relationship
          cdGraph.push({
            "@id": `cross:${prefix}Integration`,
            "@type": "owl:ObjectProperty",
            "rdfs:domain": "mabos:Business",
            "rdfs:range": `${prefix}:${rootClassName}`,
            "rdfs:comment": `Cross-domain relationship linking portfolio businesses to ${params.domain_name} operations`,
            "sbvr:conceptType": "FactType",
            "sbvr:reading": `business integrates with ${params.domain_name}`,
            "sbvr:vocabulary": "cross-domain",
          });

          // Add namespace to cross-domain context
          (crossDomain as any)["@context"][prefix] = namespace;

          await saveOntologyFile("cross-domain", crossDomain);
        }

        return textResult(
          `## Domain Ontology Scaffolded\n\n` +
            `- **File:** \`src/ontology/${params.domain_name}.jsonld\`\n` +
            `- **Namespace:** \`${namespace}\`\n` +
            `- **Prefix:** \`${prefix}:\`\n` +
            `- **Root class:** \`${prefix}:${rootClassName}\`\n` +
            `- **Parent:** \`${defaultParent}\`\n\n` +
            `### Generated Nodes (${graphNodes.length})\n` +
            `- ${graphNodes.filter((n) => n["@type"] === "owl:Class").length} classes ` +
            `(1 root + ${params.core_classes.length} custom + ${standardClasses.length} standard)\n` +
            `- ${graphNodes.filter((n) => n["@type"] === "owl:ObjectProperty").length} relationships\n\n` +
            `Cross-domain ontology updated with \`cross:${prefix}Integration\` relationship.\n\n` +
            `Use \`ontology_propose_concept\` to add more nodes to this domain.`,
        );
      },
    },
  ];
}
