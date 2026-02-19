/**
 * TypeDB Agent Tools — 4 agent-facing tools for TypeDB interaction
 *
 * - typedb_status: Check connection and database info
 * - typedb_sync_schema: Re-generate and push TypeQL schema from ontologies
 * - typedb_query: Run raw TypeQL match query
 * - typedb_sync_agent_data: Bulk import agent's JSON files into TypeDB
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import {
  getBaseSchema,
  FactStoreQueries,
  RuleStoreQueries,
  MemoryQueries,
} from "../knowledge/typedb-queries.js";
import { textResult, resolveWorkspaceDir } from "./common.js";

const TypeDBStatusParams = Type.Object({});

const TypeDBSyncSchemaParams = Type.Object({
  business_id: Type.String({ description: "Business ID (used as database name prefix)" }),
});

const TypeDBQueryParams = Type.Object({
  database: Type.String({ description: "Database name (e.g., mabos_acme)" }),
  typeql: Type.String({ description: "TypeQL match query to execute" }),
});

const TypeDBSyncAgentDataParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID whose JSON data to import" }),
  business_id: Type.String({ description: "Business ID (for database name)" }),
});

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

export function createTypeDBTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "typedb_status",
      label: "TypeDB Status",
      description: "Check TypeDB connection status, show available databases and server health.",
      parameters: TypeDBStatusParams,
      async execute(_id: string, _params: Static<typeof TypeDBStatusParams>) {
        const client = getTypeDBClient();
        const health = await client.healthCheck();

        if (!health.available) {
          return textResult(`## TypeDB Status

**Connection:** Disconnected
**Server:** Not reachable

TypeDB is not available. All knowledge operations use file-based JSON storage.
To enable TypeDB, start the server: \`typedb server\``);
        }

        return textResult(`## TypeDB Status

**Connection:** Connected
**Databases:** ${health.databases.length > 0 ? health.databases.join(", ") : "(none)"}

TypeDB is available. Knowledge operations use dual-layer storage (TypeDB + JSON).`);
      },
    },

    {
      name: "typedb_sync_schema",
      label: "Sync TypeDB Schema",
      description:
        "Re-generate TypeQL schema from ontologies and push to TypeDB. Creates the database if needed.",
      parameters: TypeDBSyncSchemaParams,
      async execute(_id: string, params: Static<typeof TypeDBSyncSchemaParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) {
          // Try connecting
          const connected = await client.connect();
          if (!connected) {
            return textResult("TypeDB is not available. Start the server first: `typedb server`");
          }
        }

        const dbName = `mabos_${params.business_id}`;

        try {
          // 1. Ensure database exists
          await client.ensureDatabase(dbName);

          // 2. Define base schema
          await client.defineSchema(getBaseSchema(), dbName);

          // 3. Load and convert ontology schema
          let ontologyStats = "skipped (ontology not loaded)";
          try {
            const { loadOntologies, mergeOntologies } = await import("../ontology/index.js");
            const { jsonldToTypeQL, generateDefineQuery } =
              await import("../knowledge/typedb-schema.js");
            const ontologies = loadOntologies();
            const graph = mergeOntologies(ontologies);
            const schema = jsonldToTypeQL(graph);
            const typeql = generateDefineQuery(schema);
            await client.defineSchema(typeql, dbName);
            ontologyStats = `${schema.entities.length} entities, ${schema.attributes.length} attributes, ${schema.relations.length} relations`;
          } catch (e) {
            ontologyStats = `failed: ${e instanceof Error ? e.message : String(e)}`;
          }

          return textResult(`## TypeDB Schema Synced

**Database:** ${dbName}
**Base schema:** defined (agents, facts, rules, memory, cases)
**Ontology schema:** ${ontologyStats}

Schema push completed successfully.`);
        } catch (e) {
          return textResult(`Schema sync failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    {
      name: "typedb_query",
      label: "TypeDB Query",
      description: "Run a raw TypeQL match query against a TypeDB database.",
      parameters: TypeDBQueryParams,
      async execute(_id: string, params: Static<typeof TypeDBQueryParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) {
          return textResult("TypeDB is not available. Start the server first.");
        }

        try {
          const results = await client.matchQuery(params.typeql, params.database);
          const resultStr = JSON.stringify(results, null, 2);
          const truncated =
            resultStr.length > 4000 ? resultStr.slice(0, 4000) + "\n... (truncated)" : resultStr;

          return textResult(`## TypeDB Query Results

**Database:** ${params.database}
**Query:**
\`\`\`typeql
${params.typeql}
\`\`\`

**Results:**
\`\`\`json
${truncated}
\`\`\``);
        } catch (e) {
          return textResult(`Query failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    {
      name: "typedb_sync_agent_data",
      label: "Sync Agent Data to TypeDB",
      description: "Bulk import an agent's JSON files (facts, rules, memory) into TypeDB.",
      parameters: TypeDBSyncAgentDataParams,
      async execute(_id: string, params: Static<typeof TypeDBSyncAgentDataParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) {
          return textResult("TypeDB is not available. Start the server first.");
        }

        const ws = resolveWorkspaceDir(api);
        const dbName = `mabos_${params.business_id}`;
        const agentDir = join(ws, "agents", params.agent_id);
        const results: string[] = [];

        // Ensure agent entity exists
        try {
          await client.insertData(
            `insert $agent isa agent, has uid ${JSON.stringify(params.agent_id)}, has name ${JSON.stringify(params.agent_id)};`,
            dbName,
          );
        } catch {
          // Agent may already exist
        }

        // Sync facts
        try {
          const factStore = await readJson(join(agentDir, "facts.json"));
          if (factStore?.facts?.length > 0) {
            let synced = 0;
            for (const fact of factStore.facts) {
              try {
                const typeql = FactStoreQueries.assertFact(params.agent_id, {
                  id: fact.id,
                  subject: fact.subject,
                  predicate: fact.predicate,
                  object: fact.object,
                  confidence: fact.confidence,
                  source: fact.source,
                  validFrom: fact.valid_from,
                  validUntil: fact.valid_until,
                  derivedFrom: fact.derived_from,
                  ruleId: fact.rule_id,
                });
                await client.insertData(typeql, dbName);
                synced++;
              } catch {
                // Skip individual fact errors
              }
            }
            results.push(`Facts: ${synced}/${factStore.facts.length} synced`);
          } else {
            results.push("Facts: 0 (empty store)");
          }
        } catch (e) {
          results.push(`Facts: error — ${e instanceof Error ? e.message : String(e)}`);
        }

        // Sync rules
        try {
          const ruleStore = await readJson(join(agentDir, "rules.json"));
          if (ruleStore?.rules?.length > 0) {
            let synced = 0;
            for (const rule of ruleStore.rules) {
              try {
                const typeql = RuleStoreQueries.createRule(params.agent_id, {
                  id: rule.id,
                  name: rule.name,
                  description: rule.description,
                  type: rule.type,
                  conditionCount: rule.conditions?.length || 0,
                  confidenceFactor: rule.confidence_factor || 0.9,
                  enabled: rule.enabled !== false,
                  domain: rule.domain,
                });
                await client.insertData(typeql, dbName);
                synced++;
              } catch {
                // Skip individual rule errors
              }
            }
            results.push(`Rules: ${synced}/${ruleStore.rules.length} synced`);
          } else {
            results.push("Rules: 0 (empty store)");
          }
        } catch (e) {
          results.push(`Rules: error — ${e instanceof Error ? e.message : String(e)}`);
        }

        // Sync memory
        try {
          const memStore = await readJson(join(agentDir, "memory-store.json"));
          if (memStore) {
            let synced = 0;
            const allItems = [
              ...(memStore.working || []).map((i: any) => ({ ...i, _store: "working" })),
              ...(memStore.short_term || []).map((i: any) => ({ ...i, _store: "short_term" })),
              ...(memStore.long_term || []).map((i: any) => ({ ...i, _store: "long_term" })),
            ];
            for (const item of allItems) {
              try {
                const typeql = MemoryQueries.storeItem(params.agent_id, {
                  id: item.id,
                  content: item.content,
                  type: item.type,
                  importance: item.importance,
                  source: item.source || "sync",
                  store: item._store,
                  tags: item.tags || [],
                });
                await client.insertData(typeql, dbName);
                synced++;
              } catch {
                // Skip individual memory errors
              }
            }
            results.push(`Memory: ${synced}/${allItems.length} synced`);
          } else {
            results.push("Memory: 0 (empty store)");
          }
        } catch (e) {
          results.push(`Memory: error — ${e instanceof Error ? e.message : String(e)}`);
        }

        return textResult(`## Agent Data Synced to TypeDB

**Agent:** ${params.agent_id}
**Database:** ${dbName}

${results.map((r) => `- ${r}`).join("\n")}`);
      },
    },
  ];
}
