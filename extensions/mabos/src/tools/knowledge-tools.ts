/**
 * Knowledge & Ontology Tools
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function readMd(p: string) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

const OntologyQueryParams = Type.Object({
  domain: Type.String({ description: "Ontology domain (e.g., 'business-core', 'ecommerce')" }),
  query: Type.String({ description: "Natural language query about the domain" }),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("class"),
        Type.Literal("property"),
        Type.Literal("individual"),
        Type.Literal("relationship"),
      ],
      { description: "Entity type filter" },
    ),
  ),
});

const KnowledgeInferParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  premises: Type.Array(Type.String(), { description: "Known facts/beliefs as premises" }),
  method: Type.Optional(
    Type.Union([Type.Literal("deductive"), Type.Literal("inductive"), Type.Literal("abductive")], {
      description: "Inference method. Default: deductive",
    }),
  ),
  question: Type.String({ description: "What to infer" }),
});

const RuleEvaluateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  rule_id: Type.String({ description: "Rule ID from playbooks/knowledge base" }),
  context: Type.Record(Type.String(), Type.Unknown(), {
    description: "Variable bindings for rule evaluation",
  }),
});

export function createKnowledgeTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "ontology_query",
      label: "Query Ontology",
      description:
        "Query the MABOS ontology (JSON-LD/OWL) for domain concepts, relationships, and constraints.",
      parameters: OntologyQueryParams,
      async execute(_id: string, params: Static<typeof OntologyQueryParams>) {
        const ws = resolveWorkspaceDir(api);
        // Look in plugin ontology dir or workspace ontologies
        const ontDir = (api.pluginConfig as any)?.ontologyDir || join(ws, "ontologies");
        const ontPath = join(ontDir, `${params.domain}.jsonld`);
        const ont = await readJson(ontPath);

        if (!ont) {
          // Fall back to plugin bundled ontologies
          const bundledPath = join(
            dirname(dirname(__dirname)),
            "src",
            "ontology",
            `${params.domain}.jsonld`,
          );
          const bundled = await readJson(bundledPath);
          if (!bundled) return textResult(`Ontology '${params.domain}' not found.`);
          return textResult(
            `## Ontology: ${params.domain}\n\nQuery: ${params.query}\n\n\`\`\`json\n${JSON.stringify(bundled, null, 2).slice(0, 4000)}\n\`\`\`\n\nAnalyze the ontology to answer: ${params.query}`,
          );
        }

        return textResult(
          `## Ontology: ${params.domain}\n\nQuery: ${params.query}\n${params.type ? `Filter: ${params.type}` : ""}\n\n\`\`\`json\n${JSON.stringify(ont, null, 2).slice(0, 4000)}\n\`\`\`\n\nAnalyze to answer: ${params.query}`,
        );
      },
    },

    {
      name: "knowledge_infer",
      label: "Knowledge Inference",
      description:
        "Run inference (deductive/inductive/abductive) over premises to derive new knowledge.",
      parameters: KnowledgeInferParams,
      async execute(_id: string, params: Static<typeof KnowledgeInferParams>) {
        const method = params.method || "deductive";
        const premisesText = params.premises.map((p, i) => `${i + 1}. ${p}`).join("\n");

        // Load agent's knowledge base for additional context
        const ws = resolveWorkspaceDir(api);
        const kb = await readMd(join(ws, "agents", params.agent_id, "Knowledge.md"));

        return textResult(`## ${method.charAt(0).toUpperCase() + method.slice(1)} Inference — ${params.agent_id}

**Premises:**
${premisesText}

**Knowledge Base:**
${kb || "No additional knowledge."}

**Question:** ${params.question}

**Method:** ${method}
${method === "deductive" ? "Apply rules to premises to derive necessary conclusions." : ""}
${method === "inductive" ? "Generalize from premises to form probable conclusions." : ""}
${method === "abductive" ? "Find the best explanation for the observed premises." : ""}

Derive the answer and state confidence level.`);
      },
    },

    {
      name: "rule_evaluate",
      label: "Evaluate Rule",
      description: "Evaluate a business rule from playbooks against current context.",
      parameters: RuleEvaluateParams,
      async execute(_id: string, params: Static<typeof RuleEvaluateParams>) {
        const ws = resolveWorkspaceDir(api);
        const playbooks = await readMd(join(ws, "agents", params.agent_id, "Playbooks.md"));

        if (!playbooks) return textResult(`No playbooks found for agent '${params.agent_id}'.`);

        return textResult(`## Rule Evaluation — ${params.rule_id}

**Playbooks:**
${playbooks}

**Context:**
\`\`\`json
${JSON.stringify(params.context, null, 2)}
\`\`\`

Find rule ${params.rule_id} in the playbooks and evaluate it against the provided context. Return: triggered (yes/no), actions to take, any exceptions.`);
      },
    },
  ];
}
