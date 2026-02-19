/**
 * Planning Tools — HTN decomposition, plan library, case adaptation, step execution
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";
import { writeNativeDailyLog } from "./memory-tools.js";

async function readMd(p: string) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}
async function writeMd(p: string, c: string) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}
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
function aDir(api: OpenClawPluginApi, id: string) {
  return join(resolveWorkspaceDir(api), "agents", id);
}

const StepSchema = Type.Object({
  id: Type.String({ description: "Step ID (e.g., 'S-1')" }),
  description: Type.String({ description: "Step description" }),
  type: Type.Union([Type.Literal("primitive"), Type.Literal("compound")], {
    description: "Primitive (directly executable) or compound (decomposes into sub-steps)",
  }),
  assigned_to: Type.Optional(Type.String({ description: "Agent or 'self'" })),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: "Predecessor step IDs" })),
  sub_steps: Type.Optional(Type.Array(Type.String(), { description: "Sub-step IDs if compound" })),
  tool: Type.Optional(Type.String({ description: "Tool to invoke for this step" })),
  estimated_duration: Type.Optional(Type.String({ description: "Duration estimate" })),
});

const DecisionPointSchema = Type.Object({
  after_step: Type.String({ description: "Step ID after which decision is needed" }),
  decision: Type.String({ description: "What needs deciding" }),
  options: Type.Array(Type.String(), { description: "Available options" }),
  criteria: Type.String({ description: "How to choose" }),
});

const RiskSchema = Type.Object({
  risk: Type.String({ description: "Risk description" }),
  impact: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  likelihood: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  mitigation: Type.String({ description: "Mitigation strategy" }),
});

const PlanGenerateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  plan_id: Type.String({ description: "Plan ID (e.g., 'P-001')" }),
  name: Type.String({ description: "Plan name" }),
  goal_id: Type.String({ description: "Goal this plan serves" }),
  source: Type.Union(
    [
      Type.Literal("cbr-retrieved"),
      Type.Literal("plan-library"),
      Type.Literal("htn-generated"),
      Type.Literal("llm-generated"),
    ],
    { description: "How this plan was created" },
  ),
  source_case: Type.Optional(Type.String({ description: "Case ID if CBR-retrieved" })),
  similarity: Type.Optional(Type.Number({ description: "Similarity score if CBR-retrieved" })),
  negative_cases: Type.Optional(
    Type.Array(Type.String(), { description: "Case IDs that failed in similar situations" }),
  ),
  confidence: Type.Number({ description: "Plan confidence 0.0-1.0" }),
  strategy: Type.String({ description: "Brief approach description" }),
  steps: Type.Array(StepSchema, { description: "HTN-decomposed steps" }),
  decision_points: Type.Optional(Type.Array(DecisionPointSchema)),
  risks: Type.Optional(Type.Array(RiskSchema)),
  adaptation_notes: Type.Optional(
    Type.String({ description: "What was adapted from source case" }),
  ),
});

const PlanExecuteStepParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  plan_id: Type.String({ description: "Plan ID" }),
  step_id: Type.String({ description: "Step ID to mark complete" }),
  outcome: Type.Union(
    [
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Literal("partial"),
      Type.Literal("skipped"),
    ],
    { description: "Step outcome" },
  ),
  result: Type.Optional(Type.String({ description: "Result details" })),
  next_step: Type.Optional(
    Type.String({ description: "Override next step (for decision points)" }),
  ),
});

const HtnDecomposeParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  goal_id: Type.String({ description: "Goal to decompose" }),
  goal_description: Type.String({ description: "What the goal aims to achieve" }),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "Constraints to satisfy" })),
  available_capabilities: Type.Optional(
    Type.Array(Type.String(), { description: "Available tools/capabilities" }),
  ),
  max_depth: Type.Optional(Type.Number({ description: "Max decomposition depth (default: 3)" })),
});

const PlanLibrarySearchParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  goal_pattern: Type.String({ description: "Goal type/pattern to search for" }),
  business_type: Type.Optional(
    Type.String({ description: "Business type for domain-specific templates" }),
  ),
});

const PlanAdaptParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  source_case_id: Type.String({ description: "Case ID to adapt from" }),
  target_goal_id: Type.String({ description: "Goal to adapt the plan for" }),
  differences: Type.Array(
    Type.Object({
      aspect: Type.String({ description: "What differs" }),
      source_value: Type.String({ description: "Value in source case" }),
      target_value: Type.String({ description: "Value in current situation" }),
    }),
    { description: "Known differences between source and target" },
  ),
});

export function createPlanningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "plan_generate",
      label: "Generate Plan",
      description:
        "Create an HTN-decomposed plan with steps, decision points, risks, and CBR provenance tracking.",
      parameters: PlanGenerateParams,
      async execute(_id: string, params: Static<typeof PlanGenerateParams>) {
        const dir = aDir(api, params.agent_id);
        const path = join(dir, "Plans.md");
        const now = new Date().toISOString();

        let content = await readMd(path);
        if (!content) {
          content = `# Plans — ${params.agent_id}\n\nLast updated: ${now}\n\n## Active Plans\n\n## Plan Library References\n\n| Template | Name | Goals | Success Rate |\n|---|---|---|---|\n\n## Archived Plans\n\n| ID | Plan | Goal | Source | Outcome | Case Stored |\n|---|---|---|---|---|---|\n`;
        }

        const stepsText = params.steps
          .map(
            (s) =>
              `| ${s.id} | ${s.description} | ${s.type} | ${s.assigned_to || "self"} | ${s.depends_on?.join(", ") || "—"} | pending | ${s.estimated_duration || "—"} |`,
          )
          .join("\n");

        const dpText =
          params.decision_points
            ?.map(
              (dp) =>
                `| ${dp.after_step} | ${dp.decision} | ${dp.options.join(", ")} | ${dp.criteria} | pending |`,
            )
            .join("\n") || "";

        const riskText =
          params.risks
            ?.map((r) => `| ${r.risk} | ${r.impact} | ${r.likelihood} | ${r.mitigation} | no |`)
            .join("\n") || "";

        const entry = `\n### ${params.plan_id}: ${params.name}
- **Goal:** ${params.goal_id}
- **Source:** ${params.source}${params.source_case ? ` (case: ${params.source_case}, similarity: ${params.similarity})` : ""}
- **Negative Cases Checked:** ${params.negative_cases?.length ? `[${params.negative_cases.join(", ")}]` : "none"}
- **Status:** active
- **Confidence:** ${params.confidence}
- **Strategy:** ${params.strategy}
- **Created:** ${now.split("T")[0]}

#### Steps (HTN Decomposition)

| Step | Description | Type | Assigned | Depends On | Status | Est. Duration |
|---|---|---|---|---|---|---|
${stepsText}

${params.decision_points?.length ? `#### Decision Points\n\n| After Step | Decision | Options | Criteria | Chosen |\n|---|---|---|---|---|\n${dpText}\n` : ""}
${params.adaptation_notes ? `#### Adaptation Notes\n${params.adaptation_notes}\n` : ""}
${params.risks?.length ? `#### Risks\n\n| Risk | Impact | Likelihood | Mitigation | Triggered? |\n|---|---|---|---|---|\n${riskText}\n` : ""}`;

        const archiveIdx = content.indexOf("## Plan Library References");
        if (archiveIdx !== -1) {
          content = content.slice(0, archiveIdx) + entry + "\n" + content.slice(archiveIdx);
        } else {
          content += entry;
        }

        content = content.replace(/Last updated: .*/, `Last updated: ${now}`);
        await writeMd(path, content);
        return textResult(
          `Plan ${params.plan_id} created: "${params.name}" (${params.source}, confidence: ${params.confidence}, ${params.steps.length} steps)`,
        );
      },
    },

    {
      name: "plan_execute_step",
      label: "Execute Plan Step",
      description: "Record step completion and log to agent memory for case learning.",
      parameters: PlanExecuteStepParams,
      async execute(_id: string, params: Static<typeof PlanExecuteStepParams>) {
        const dir = aDir(api, params.agent_id);
        const now = new Date().toISOString();

        // Log to memory
        const memPath = join(dir, "Memory.md");
        let mem = await readMd(memPath);
        mem += `\n- [${now.split("T")[0]}] Plan ${params.plan_id} / Step ${params.step_id}: **${params.outcome}**${params.result ? ` — ${params.result}` : ""}`;
        await writeMd(memPath, mem);

        // Bridge to native OpenClaw daily log format
        await writeNativeDailyLog(api, params.agent_id, {
          type: "event",
          content: `Plan ${params.plan_id} / Step ${params.step_id}: ${params.outcome}${params.result ? ` — ${params.result}` : ""}`,
          source: "plan-execution",
        });

        return textResult(
          `Step ${params.step_id} of ${params.plan_id}: ${params.outcome}${params.result ? ` — ${params.result}` : ""}${params.next_step ? `\nNext: ${params.next_step}` : ""}`,
        );
      },
    },

    {
      name: "htn_decompose",
      label: "HTN Decompose",
      description:
        "Decompose a goal into a hierarchical task network. Returns compound and primitive tasks for plan generation.",
      parameters: HtnDecomposeParams,
      async execute(_id: string, params: Static<typeof HtnDecomposeParams>) {
        const dir = aDir(api, params.agent_id);
        const capabilities = await readMd(join(dir, "Capabilities.md"));
        const playbooks = await readMd(join(dir, "Playbooks.md"));
        const plans = await readMd(join(dir, "Plans.md"));

        return textResult(`## HTN Decomposition — ${params.goal_id}

**Goal:** ${params.goal_description}
**Max Depth:** ${params.max_depth || 3}
${params.constraints?.length ? `**Constraints:** ${params.constraints.join("; ")}` : ""}

**Agent Capabilities:**
${capabilities || "Not defined."}

**Existing Playbooks:**
${playbooks || "None."}

**Existing Plans (for reuse):**
${plans || "None."}

${params.available_capabilities?.length ? `**Available Tools:** ${params.available_capabilities.join(", ")}` : ""}

**Instructions:**
1. Break the goal into compound tasks (high-level phases)
2. Decompose each compound task into primitive tasks (directly executable actions)
3. Identify dependencies between tasks
4. Mark tasks that can be parallelized
5. Identify decision points where the plan might branch
6. Check playbooks for reusable patterns
7. Assign each primitive task to self or another agent

Output a plan_generate call with the decomposed steps.`);
      },
    },

    {
      name: "plan_library_search",
      label: "Search Plan Library",
      description: "Search plan templates in the library for applicable patterns.",
      parameters: PlanLibrarySearchParams,
      async execute(_id: string, params: Static<typeof PlanLibrarySearchParams>) {
        const ws = resolveWorkspaceDir(api);
        const dir = aDir(api, params.agent_id);

        // Check agent's plan library
        const plans = await readMd(join(dir, "Plans.md"));

        // Check business type templates
        let templates = "";
        if (params.business_type) {
          const templateDir = join(ws, "extensions", "mabos", "templates", params.business_type);
          const templatePlans = await readMd(join(templateDir, "plan-templates.md"));
          if (templatePlans) templates = templatePlans;
        }

        // Check base templates
        const basePlans = await readMd(
          join(ws, "extensions", "mabos", "templates", "base", "plan-templates.md"),
        );

        return textResult(`## Plan Library Search

**Goal Pattern:** ${params.goal_pattern}
${params.business_type ? `**Business Type:** ${params.business_type}` : ""}

**Agent Plan History:**
${plans || "No plan history."}

${templates ? `**Domain Templates:**\n${templates}\n` : ""}
${basePlans ? `**Base Templates:**\n${basePlans}\n` : "No base templates found."}

Search for plans matching "${params.goal_pattern}" and return applicable templates with success rates.`);
      },
    },

    {
      name: "plan_adapt",
      label: "Adapt Plan from Case",
      description:
        "Adapt a retrieved CBR case plan for the current situation, accounting for known differences.",
      parameters: PlanAdaptParams,
      async execute(_id: string, params: Static<typeof PlanAdaptParams>) {
        const ws = resolveWorkspaceDir(api);
        const dir = aDir(api, params.agent_id);
        const cases = (await readJson(join(dir, "cases.json"))) || [];
        const sourceCase = cases.find((c: any) => c.case_id === params.source_case_id);

        if (!sourceCase) return textResult(`Case '${params.source_case_id}' not found.`);

        const diffsText = params.differences
          .map((d) => `- **${d.aspect}:** ${d.source_value} → ${d.target_value}`)
          .join("\n");

        return textResult(`## Plan Adaptation — from ${params.source_case_id}

**Source Case:**
\`\`\`json
${JSON.stringify(sourceCase, null, 2)}
\`\`\`

**Target Goal:** ${params.target_goal_id}

**Known Differences:**
${diffsText}

**Instructions:**
1. Identify which steps from the source plan are directly reusable
2. Determine which steps need modification due to the differences
3. Add new steps needed for the target context
4. Remove steps that don't apply
5. Adjust timing and dependencies
6. Check source case's outcome — if partially successful, note what failed
7. Generate a plan_generate call with the adapted plan (source: cbr-retrieved)`);
      },
    },
  ];
}
