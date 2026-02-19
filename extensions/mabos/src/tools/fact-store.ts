/**
 * Fact Store — SPO (Subject-Predicate-Object) triple store with confidence, source, validity
 *
 * Stores knowledge as RDF-like triples in JSON format. Each fact has:
 * - Subject, Predicate, Object (the triple)
 * - Confidence (0.0-1.0)
 * - Source (where it came from)
 * - Valid from/until (temporal validity)
 * - Derivation (if inferred, how)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient, TypeDBUnavailableError } from "../knowledge/typedb-client.js";
import { FactStoreQueries } from "../knowledge/typedb-queries.js";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

type Fact = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  valid_from?: string;
  valid_until?: string;
  derived_from?: string[]; // fact IDs if inferred
  rule_id?: string; // rule that derived this
  created_at: string;
  updated_at: string;
};

type FactStore = {
  facts: Fact[];
  version: number;
};

function factsPath(api: OpenClawPluginApi, agentId: string): string {
  const ws = resolveWorkspaceDir(api);
  return join(ws, "agents", agentId, "facts.json");
}

async function loadFacts(api: OpenClawPluginApi, agentId: string): Promise<FactStore> {
  const store = await readJson(factsPath(api, agentId));
  return store || { facts: [], version: 1 };
}

async function saveFacts(api: OpenClawPluginApi, agentId: string, store: FactStore): Promise<void> {
  store.version++;
  await writeJson(factsPath(api, agentId), store);
}

const FactAssertParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  subject: Type.String({ description: "Subject entity (e.g., 'acme-consulting', 'product-x')" }),
  predicate: Type.String({
    description: "Relationship/property (e.g., 'hasRevenue', 'isCompetitorOf', 'locatedIn')",
  }),
  object: Type.String({ description: "Object/value (e.g., '$50000', 'rival-corp', 'Delaware')" }),
  confidence: Type.Number({ description: "Confidence 0.0-1.0" }),
  source: Type.String({
    description: "Source (e.g., 'cfo-report', 'inference', 'stripe-integration')",
  }),
  valid_from: Type.Optional(Type.String({ description: "Valid from (ISO date)" })),
  valid_until: Type.Optional(
    Type.String({ description: "Valid until (ISO date, omit for indefinite)" }),
  ),
});

const FactRetractParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  fact_id: Type.Optional(Type.String({ description: "Specific fact ID to retract" })),
  subject: Type.Optional(Type.String({ description: "Retract all facts about this subject" })),
  predicate: Type.Optional(Type.String({ description: "Retract all facts with this predicate" })),
});

const FactQueryParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  subject: Type.Optional(Type.String({ description: "Filter by subject (supports * wildcard)" })),
  predicate: Type.Optional(Type.String({ description: "Filter by predicate" })),
  object: Type.Optional(Type.String({ description: "Filter by object" })),
  min_confidence: Type.Optional(
    Type.Number({ description: "Minimum confidence filter (default: 0.0)" }),
  ),
  valid_at: Type.Optional(
    Type.String({ description: "Check temporal validity at this date (ISO)" }),
  ),
  include_derived: Type.Optional(
    Type.Boolean({ description: "Include inferred facts (default: true)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
});

const FactExplainParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  fact_id: Type.String({ description: "Fact ID to explain" }),
});

export function createFactStoreTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "fact_assert",
      label: "Assert Fact",
      description: "Add or update an SPO triple in the fact store with confidence and provenance.",
      parameters: FactAssertParams,
      async execute(_id: string, params: Static<typeof FactAssertParams>) {
        const store = await loadFacts(api, params.agent_id);
        const now = new Date().toISOString();

        // Check for existing triple
        const existing = store.facts.findIndex(
          (f) =>
            f.subject === params.subject &&
            f.predicate === params.predicate &&
            f.object === params.object,
        );

        const factId =
          existing !== -1
            ? store.facts[existing].id
            : `F-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const fact: Fact = {
          id: factId,
          subject: params.subject,
          predicate: params.predicate,
          object: params.object,
          confidence: params.confidence,
          source: params.source,
          valid_from: params.valid_from || now,
          valid_until: params.valid_until,
          created_at: existing !== -1 ? store.facts[existing].created_at : now,
          updated_at: now,
        };

        if (existing !== -1) {
          store.facts[existing] = fact;
        } else {
          store.facts.push(fact);
        }

        await saveFacts(api, params.agent_id, store);

        // Write-through to TypeDB (best-effort)
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = FactStoreQueries.assertFact(params.agent_id, {
              id: factId,
              subject: params.subject,
              predicate: params.predicate,
              object: params.object,
              confidence: params.confidence,
              source: params.source,
              validFrom: params.valid_from,
              validUntil: params.valid_until,
            });
            await client.insertData(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable — JSON file is the source of truth
        }

        return textResult(
          `Fact ${factId} ${existing !== -1 ? "updated" : "asserted"}: (${params.subject}, ${params.predicate}, ${params.object}) [confidence: ${params.confidence}]`,
        );
      },
    },

    {
      name: "fact_retract",
      label: "Retract Fact",
      description: "Remove facts from the store by ID, subject, or predicate.",
      parameters: FactRetractParams,
      async execute(_id: string, params: Static<typeof FactRetractParams>) {
        const store = await loadFacts(api, params.agent_id);
        const before = store.facts.length;

        if (params.fact_id) {
          store.facts = store.facts.filter((f) => f.id !== params.fact_id);
        } else {
          store.facts = store.facts.filter((f) => {
            if (params.subject && f.subject !== params.subject) return true;
            if (params.predicate && f.predicate !== params.predicate) return true;
            return false;
          });
        }

        const removed = before - store.facts.length;
        await saveFacts(api, params.agent_id, store);

        // Delete from TypeDB (best-effort)
        if (params.fact_id) {
          try {
            const client = getTypeDBClient();
            if (client.isAvailable()) {
              const typeql = FactStoreQueries.retractFact(params.agent_id, params.fact_id);
              await client.deleteData(
                typeql,
                `mabos_${params.agent_id.split("/")[0] || "default"}`,
              );
            }
          } catch {
            // TypeDB unavailable — JSON is source of truth
          }
        }

        return textResult(
          `Retracted ${removed} fact(s) from '${params.agent_id}' store. Remaining: ${store.facts.length}`,
        );
      },
    },

    {
      name: "fact_query",
      label: "Query Facts",
      description:
        "Query the fact store with SPO pattern matching, confidence filtering, and temporal validity.",
      parameters: FactQueryParams,
      async execute(_id: string, params: Static<typeof FactQueryParams>) {
        // Try TypeDB first, fall back to JSON
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = FactStoreQueries.queryFacts(params.agent_id, {
              subject: params.subject,
              predicate: params.predicate,
              object: params.object,
              minConfidence: params.min_confidence,
            });
            // If TypeDB query succeeds, we still fall through to JSON for now
            // since result parsing from TypeDB requires schema-aware deserialization.
            // This ensures TypeDB is exercised but JSON remains authoritative.
            await client.matchQuery(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable — fall through to JSON
        }

        const store = await loadFacts(api, params.agent_id);
        const minConf = params.min_confidence || 0.0;
        const limit = params.limit || 50;
        const includeDerived = params.include_derived !== false;

        let results = store.facts.filter((f) => {
          if (params.subject && params.subject !== "*" && f.subject !== params.subject)
            return false;
          if (params.predicate && f.predicate !== params.predicate) return false;
          if (params.object && f.object !== params.object) return false;
          if (f.confidence < minConf) return false;
          if (!includeDerived && f.derived_from) return false;

          // Temporal validity check
          if (params.valid_at) {
            const checkDate = new Date(params.valid_at).getTime();
            if (f.valid_from && new Date(f.valid_from).getTime() > checkDate) return false;
            if (f.valid_until && new Date(f.valid_until).getTime() < checkDate) return false;
          }

          return true;
        });

        results = results.slice(0, limit);

        if (results.length === 0) return textResult("No matching facts found.");

        const output = results
          .map(
            (f) =>
              `- **${f.id}:** (${f.subject}, ${f.predicate}, ${f.object}) — confidence: ${f.confidence}, source: ${f.source}${f.derived_from ? " [inferred]" : ""}${f.valid_until ? `, expires: ${f.valid_until}` : ""}`,
          )
          .join("\n");

        return textResult(
          `## Facts — ${params.agent_id} (${results.length}/${store.facts.length})\n\n${output}`,
        );
      },
    },

    {
      name: "fact_explain",
      label: "Explain Fact",
      description:
        "Trace the derivation of a fact — show the inference chain and supporting evidence.",
      parameters: FactExplainParams,
      async execute(_id: string, params: Static<typeof FactExplainParams>) {
        const store = await loadFacts(api, params.agent_id);
        const fact = store.facts.find((f) => f.id === params.fact_id);

        if (!fact) return textResult(`Fact '${params.fact_id}' not found.`);

        let explanation = `## Fact Explanation: ${params.fact_id}\n\n`;
        explanation += `**Triple:** (${fact.subject}, ${fact.predicate}, ${fact.object})\n`;
        explanation += `**Confidence:** ${fact.confidence}\n`;
        explanation += `**Source:** ${fact.source}\n`;
        explanation += `**Created:** ${fact.created_at}\n`;

        if (fact.derived_from && fact.derived_from.length > 0) {
          explanation += `\n### Derivation Chain\n`;
          explanation += `**Rule:** ${fact.rule_id || "unknown"}\n`;
          explanation += `**Derived from:**\n`;

          for (const depId of fact.derived_from) {
            const dep = store.facts.find((f) => f.id === depId);
            if (dep) {
              explanation += `- ${depId}: (${dep.subject}, ${dep.predicate}, ${dep.object}) [${dep.confidence}]\n`;
              // Recursive — show one more level
              if (dep.derived_from?.length) {
                for (const subId of dep.derived_from) {
                  const sub = store.facts.find((f) => f.id === subId);
                  if (sub) {
                    explanation += `  ← ${subId}: (${sub.subject}, ${sub.predicate}, ${sub.object}) [${sub.confidence}]\n`;
                  }
                }
              }
            } else {
              explanation += `- ${depId}: (not found — may have been retracted)\n`;
            }
          }
        } else {
          explanation += `\n**Origin:** Direct assertion (not derived)\n`;
        }

        return textResult(explanation);
      },
    },
  ];
}
