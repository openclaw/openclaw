/**
 * Reasoning Tools — 20 reasoning tools via meta-reasoning router
 *
 * Central registration hub. The upgraded `reason` tool supports:
 * - Backward-compatible single-method invocation (method param)
 * - Auto-selection via problem_classification
 * - Multi-method fusion via multi_method flag
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createCausalReasoningTools } from "../reasoning/causal/index.js";
import { createExperienceReasoningTools } from "../reasoning/experience/index.js";
import { createFormalReasoningTools } from "../reasoning/formal/index.js";
import { fuseResults, formatFusionPrompt } from "../reasoning/fusion.js";
import { createMetaReasoningTools } from "../reasoning/meta/index.js";
import { scoreMethodsForProblem } from "../reasoning/meta/meta-reasoning.js";
import { REASONING_METHODS } from "../reasoning/methods.js";
import { createProbabilisticReasoningTools } from "../reasoning/probabilistic/index.js";
import { createSocialReasoningTools } from "../reasoning/social/index.js";
import type { ProblemClassification, ReasoningResult } from "../reasoning/types.js";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readMd(p: string) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

const ProblemClassificationSchema = Type.Object({
  uncertainty: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  complexity: Type.Union([
    Type.Literal("simple"),
    Type.Literal("moderate"),
    Type.Literal("complex"),
  ]),
  domain: Type.Union([
    Type.Literal("formal"),
    Type.Literal("empirical"),
    Type.Literal("social"),
    Type.Literal("mixed"),
  ]),
  time_pressure: Type.Union([
    Type.Literal("none"),
    Type.Literal("moderate"),
    Type.Literal("urgent"),
  ]),
  data_availability: Type.Union([
    Type.Literal("rich"),
    Type.Literal("moderate"),
    Type.Literal("sparse"),
  ]),
  stakes: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

const ReasonParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  method: Type.Optional(
    Type.String({
      description: `Reasoning method: ${Object.keys(REASONING_METHODS).join(", ")}`,
    }),
  ),
  problem: Type.String({ description: "Problem statement" }),
  context: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Additional context" }),
  ),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "Constraints to satisfy" })),
  problem_classification: Type.Optional(ProblemClassificationSchema),
  multi_method: Type.Optional(
    Type.Boolean({ description: "Run multiple methods and fuse results" }),
  ),
  methods: Type.Optional(
    Type.Array(Type.String(), {
      description: "Explicit list of methods to run (with multi_method)",
    }),
  ),
});

function createReasonRouter(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason",
    label: "Reason",
    description:
      "Apply reasoning to a problem. Supports 35 methods across formal, probabilistic, causal, experience, social, and meta categories. " +
      "Use `method` for a single method (backward compatible), `problem_classification` for auto-selection, or `multi_method` for fusion.",
    parameters: ReasonParams,
    async execute(_id: string, params: Static<typeof ReasonParams>) {
      const ws = resolveWorkspaceDir(api);
      const beliefs = await readMd(join(ws, "agents", params.agent_id, "Beliefs.md"));
      const kb = await readMd(join(ws, "agents", params.agent_id, "Knowledge.md"));

      const agentContext = `**Agent Beliefs:**\n${beliefs || "None."}\n\n**Knowledge Base:**\n${kb || "None."}`;
      const extraContext = params.context
        ? `**Context:**\n\`\`\`json\n${JSON.stringify(params.context, null, 2)}\n\`\`\``
        : "";
      const constraintText = params.constraints?.length
        ? `**Constraints:** ${params.constraints.join("; ")}`
        : "";

      // ── Mode 1: Explicit single method (backward compatible) ──
      if (params.method && !params.multi_method) {
        const method = REASONING_METHODS[params.method];
        if (!method)
          return textResult(
            `Unknown method '${params.method}'. Available: ${Object.keys(REASONING_METHODS).join(", ")}`,
          );

        return textResult(`## ${params.method} Reasoning (${method.category}) — ${params.agent_id}

**Problem:** ${params.problem}

${method.prompt}

${agentContext}

${extraContext}
${constraintText}

Apply ${params.method} reasoning systematically and state your conclusion with confidence level.`);
      }

      // ── Mode 2: Auto-select via problem classification ──
      if (params.problem_classification && !params.multi_method) {
        const recommendations = scoreMethodsForProblem(params.problem_classification);
        const topMethod = recommendations[0];
        const method = REASONING_METHODS[topMethod.method];

        return textResult(`## Auto-Selected: ${topMethod.method} Reasoning (${method.category}) — ${params.agent_id}

**Problem:** ${params.problem}

**Selection rationale:** ${topMethod.rationale} (score: ${(topMethod.score * 100).toFixed(0)}%)

${method.prompt}

${agentContext}

${extraContext}
${constraintText}

Apply ${topMethod.method} reasoning systematically and state your conclusion with confidence level.`);
      }

      // ── Mode 3: Multi-method fusion ──
      if (params.multi_method) {
        let selectedMethods: string[];

        if (params.methods && params.methods.length > 0) {
          // Use explicitly provided methods
          selectedMethods = params.methods.filter((m) => m in REASONING_METHODS);
        } else if (params.problem_classification) {
          // Auto-select top 3 from classification
          const recommendations = scoreMethodsForProblem(params.problem_classification);
          selectedMethods = recommendations.slice(0, 3).map((r) => r.method);
        } else {
          // Default: pick diverse methods
          selectedMethods = ["deductive", "heuristic", "causal"].filter(
            (m) => m in REASONING_METHODS,
          );
        }

        if (selectedMethods.length === 0) {
          return textResult("No valid methods selected for multi-method reasoning.");
        }

        // Generate simulated results for LLM synthesis
        const results: ReasoningResult[] = selectedMethods.map((methodName) => {
          const method = REASONING_METHODS[methodName];
          return {
            method: methodName,
            category: method.category,
            conclusion: `[Pending ${methodName} analysis]`,
            confidence: 0.5,
            reasoning_trace: method.prompt,
          };
        });

        const fusion = fuseResults(results);
        const fusionPrompt = formatFusionPrompt(fusion);

        const methodPrompts = selectedMethods
          .map((methodName) => {
            const method = REASONING_METHODS[methodName];
            return `### Method: ${methodName} (${method.category})\n${method.prompt}`;
          })
          .join("\n\n");

        return textResult(`## Multi-Method Reasoning — ${params.agent_id}

**Problem:** ${params.problem}

**Methods selected:** ${selectedMethods.join(", ")}

${agentContext}

${extraContext}
${constraintText}

---

Apply EACH of the following methods to the problem, then synthesize:

${methodPrompts}

---

## Synthesis Instructions

After applying each method independently:
1. State the conclusion from each method with confidence level
2. Identify agreements and disagreements
3. Produce a unified conclusion that weighs each method's strengths
4. State overall confidence`);
      }

      // ── Fallback: no method specified, use default reasoning ──
      return textResult(`## General Reasoning — ${params.agent_id}

**Problem:** ${params.problem}

${agentContext}

${extraContext}
${constraintText}

Analyze this problem using the most appropriate reasoning approach. Consider formal logic, probabilistic analysis, causal relationships, and practical experience. State your conclusion with confidence level.

Tip: For targeted reasoning, specify a \`method\` (${Object.keys(REASONING_METHODS).slice(0, 5).join(", ")}, ...) or provide \`problem_classification\` for auto-selection.`);
    },
  };
}

export function createReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    createReasonRouter(api),
    ...createFormalReasoningTools(api),
    ...createProbabilisticReasoningTools(api),
    ...createCausalReasoningTools(api),
    ...createExperienceReasoningTools(api),
    ...createSocialReasoningTools(api),
    ...createMetaReasoningTools(api),
  ];
}
