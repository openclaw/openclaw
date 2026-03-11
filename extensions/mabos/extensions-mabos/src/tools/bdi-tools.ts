/**
 * BDI Cognitive Tools
 *
 * Core tools for the Belief-Desire-Intention cognitive architecture.
 * Operates on the 10-file agent cognitive system (markdown-based).
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

// --- Helpers ---

async function readMd(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function writeMd(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

function agentDir(api: OpenClawPluginApi, agentId: string): string {
  const ws = resolveWorkspaceDir(api);
  return join(ws, "agents", agentId);
}

// --- Tools ---

const BeliefGetParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID (e.g., 'cfo', 'coo')" }),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal("environment"),
        Type.Literal("self"),
        Type.Literal("agent"),
        Type.Literal("case"),
        Type.Literal("all"),
      ],
      { description: "Belief category to filter. Default: all" },
    ),
  ),
});

const BeliefUpdateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  belief_id: Type.String({ description: "Belief ID (BE=environment, BS=self, BA=agent, BC=case)" }),
  category: Type.Union(
    [
      Type.Literal("environment"),
      Type.Literal("self"),
      Type.Literal("agent"),
      Type.Literal("case"),
    ],
    { description: "Belief category" },
  ),
  description: Type.String({ description: "Human-readable belief description" }),
  value: Type.String({ description: "The belief value" }),
  certainty: Type.Number({ description: "Certainty level 0.0-1.0" }),
  source: Type.String({ description: "Source of the belief" }),
});

const GoalCreateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  goal_id: Type.String({ description: "Goal ID (e.g., 'G-001')" }),
  level: Type.Union(
    [Type.Literal("strategic"), Type.Literal("tactical"), Type.Literal("operational")],
    { description: "Goal hierarchy level" },
  ),
  description: Type.String({ description: "Specific, measurable goal description" }),
  priority: Type.Number({ description: "Priority 0.0-1.0" }),
  desire_id: Type.Optional(Type.String({ description: "Linked desire ID" })),
  target: Type.Optional(Type.String({ description: "Measurable target value" })),
  deadline: Type.Optional(Type.String({ description: "Deadline (ISO date or 'ongoing')" })),
  parent_goal: Type.Optional(Type.String({ description: "Parent goal ID" })),
  success_criteria: Type.Optional(Type.String({ description: "How to determine achievement" })),
  business_goal_id: Type.Optional(
    Type.String({
      description: "Tropos business goal ID for traceability (e.g., 'BG-revenue-growth')",
    }),
  ),
});

const GoalEvaluateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  goal_id: Type.Optional(Type.String({ description: "Goal ID to evaluate, or omit for all" })),
});

const IntentionCommitParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  intention_id: Type.String({ description: "Intention ID (e.g., 'I-001')" }),
  goal_id: Type.String({ description: "Goal this intention serves" }),
  plan_id: Type.String({ description: "Plan to commit to" }),
  strategy: Type.Union(
    [Type.Literal("single-minded"), Type.Literal("open-minded"), Type.Literal("cautious")],
    { description: "Commitment strategy" },
  ),
});

const BdiCycleParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID to run the cycle for" }),
  depth: Type.Union([Type.Literal("quick"), Type.Literal("full")], {
    description: "Quick: goals+intentions only. Full: complete 5-phase BDI cycle.",
  }),
});

const SkillInventoryParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID to inventory skills for" }),
});

const ActionLogParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  tool_name: Type.String({ description: "Name of the tool/action executed" }),
  task_id: Type.Optional(Type.String({ description: "Related task ID (e.g., 'T-003')" })),
  outcome: Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("partial")], {
    description: "Outcome of the action",
  }),
  summary: Type.String({ description: "Brief summary of what the action accomplished" }),
});

export function createBdiTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "belief_get",
      label: "Get Beliefs",
      description:
        "Read an agent's beliefs (environment, self, agent, case categories) with certainty levels and sources.",
      parameters: BeliefGetParams,
      async execute(_id: string, params: Static<typeof BeliefGetParams>) {
        const dir = agentDir(api, params.agent_id);
        const content = await readMd(join(dir, "Beliefs.md"));
        if (!content) return textResult(`No beliefs found for agent '${params.agent_id}'.`);

        const cat = params.category || "all";
        if (cat !== "all") {
          const headers: Record<string, string> = {
            environment: "Environment Beliefs",
            self: "Self Beliefs",
            agent: "Agent Beliefs",
            case: "Case Beliefs",
          };
          const h = headers[cat];
          if (h) {
            const re = new RegExp(`## ${h}[\\s\\S]*?(?=\\n## |$)`, "m");
            const m = content.match(re);
            return textResult(m ? m[0] : `No ${cat} beliefs found.`);
          }
        }
        return textResult(content);
      },
    },

    {
      name: "belief_update",
      label: "Update Belief",
      description:
        "Update or create a belief with certainty, source tracking, and revision logging.",
      parameters: BeliefUpdateParams,
      async execute(_id: string, params: Static<typeof BeliefUpdateParams>) {
        const dir = agentDir(api, params.agent_id);
        const path = join(dir, "Beliefs.md");
        const now = new Date().toISOString();

        let content = await readMd(path);
        if (!content) {
          content = `# Beliefs — ${params.agent_id}\n\nLast updated: ${now}\nRevision count: 0\n\n## Environment Beliefs\n\n| ID | Belief | Value | Certainty | Source | Updated |\n|---|---|---|---|---|---|\n\n## Self Beliefs\n\n| ID | Belief | Value | Certainty | Source | Updated |\n|---|---|---|---|---|---|\n\n## Agent Beliefs\n\n| ID | About | Belief | Value | Certainty | Source | Updated |\n|---|---|---|---|---|---|---|\n\n## Case Beliefs\n\n| ID | Pattern | Frequency | Confidence | Implications |\n|---|---|---|---|---|\n\n## Belief Revision Log\n\n| Date | ID | Change | Old | New | Source |\n|---|---|---|---|---|---|\n`;
        }

        const isUpdate = content.includes(params.belief_id);
        const change = isUpdate ? "updated" : "created";
        const rev = `| ${now.split("T")[0]} | ${params.belief_id} | ${change} | — | ${params.value} | ${params.source} |`;

        // Append revision
        const logIdx = content.indexOf("## Belief Revision Log");
        if (logIdx !== -1) {
          const tableEnd = content.indexOf("\n\n", content.indexOf("|---|", logIdx));
          if (tableEnd !== -1) {
            content = content.slice(0, tableEnd) + "\n" + rev + content.slice(tableEnd);
          }
        }

        content = content.replace(/Last updated: .*/, `Last updated: ${now}`);
        await writeMd(path, content);
        return textResult(
          `Belief ${params.belief_id} ${change} for '${params.agent_id}' (certainty: ${params.certainty}, source: ${params.source})`,
        );
      },
    },

    {
      name: "goal_create",
      label: "Create Goal",
      description:
        "Create a goal in the 3-tier hierarchy (strategic/tactical/operational) linked to desires.",
      parameters: GoalCreateParams,
      async execute(_id: string, params: Static<typeof GoalCreateParams>) {
        const dir = agentDir(api, params.agent_id);
        const path = join(dir, "Goals.md");
        const now = new Date().toISOString();

        let content = await readMd(path);
        if (!content) {
          content = `# Goals — ${params.agent_id}\n\nLast evaluated: ${now}\n\n## Active Goals\n\n## Completed Goals\n\n| ID | Goal | Completed | Outcome |\n|---|---|---|---|\n\n## Abandoned Goals\n\n| ID | Goal | Reason | Learnings |\n|---|---|---|---|\n`;
        }

        const businessGoalLine = params.business_goal_id
          ? `\n- **Business Goal:** ${params.business_goal_id}`
          : "";
        const entry = `\n### ${params.goal_id}: ${params.description}\n- **Level:** ${params.level}\n- **Priority:** ${params.priority}\n- **Desire:** ${params.desire_id || "—"}\n- **Status:** active\n- **Target:** ${params.target || "—"}\n- **Progress:** 0%\n- **Deadline:** ${params.deadline || "ongoing"}\n- **Parent:** ${params.parent_goal || "—"}\n- **Success Criteria:** ${params.success_criteria || "—"}${businessGoalLine}\n- **Created:** ${now.split("T")[0]}\n`;

        const completedIdx = content.indexOf("## Completed Goals");
        if (completedIdx !== -1) {
          content = content.slice(0, completedIdx) + entry + "\n" + content.slice(completedIdx);
        } else {
          content += entry;
        }

        content = content.replace(/Last evaluated: .*/, `Last evaluated: ${now}`);
        await writeMd(path, content);
        return textResult(
          `Goal ${params.goal_id} created for '${params.agent_id}' (${params.level}, priority: ${params.priority})`,
        );
      },
    },

    {
      name: "goal_evaluate",
      label: "Evaluate Goals",
      description: "Evaluate goal progress against beliefs, intentions, and blockers.",
      parameters: GoalEvaluateParams,
      async execute(_id: string, params: Static<typeof GoalEvaluateParams>) {
        const dir = agentDir(api, params.agent_id);
        const goals = await readMd(join(dir, "Goals.md"));
        const beliefs = await readMd(join(dir, "Beliefs.md"));
        const intentions = await readMd(join(dir, "Intentions.md"));

        if (!goals) return textResult(`No goals found for agent '${params.agent_id}'.`);

        return textResult(
          `## Goal Evaluation — ${params.agent_id}\n\n### Goals:\n${goals}\n\n### Beliefs:\n${beliefs || "None."}\n\n### Intentions:\n${intentions || "None."}\n\nEvaluate each active goal: achievable? progress? blockers? replan needed?`,
        );
      },
    },

    {
      name: "intention_commit",
      label: "Commit Intention",
      description: "Commit to a plan with single-minded, open-minded, or cautious strategy.",
      parameters: IntentionCommitParams,
      async execute(_id: string, params: Static<typeof IntentionCommitParams>) {
        const dir = agentDir(api, params.agent_id);
        const path = join(dir, "Intentions.md");
        const now = new Date().toISOString();

        let content = await readMd(path);
        if (!content) {
          content = `# Intentions — ${params.agent_id}\n\nLast updated: ${now}\n\n## Active Intentions\n\n## Completed\n\n| ID | Goal | Completed | Outcome |\n|---|---|---|---|\n\n## Dropped\n\n| ID | Reason | Lesson |\n|---|---|---|\n`;
        }

        const entry = `\n### ${params.intention_id}: ${params.goal_id} via ${params.plan_id}\n- **Strategy:** ${params.strategy}\n- **Status:** executing\n- **Current Step:** S-1\n- **Progress:** 0%\n- **Started:** ${now.split("T")[0]}\n`;

        const activeIdx = content.indexOf("## Active Intentions");
        if (activeIdx !== -1) {
          const insertAt = content.indexOf("\n", activeIdx) + 1;
          content = content.slice(0, insertAt) + entry + content.slice(insertAt);
        }

        content = content.replace(/Last updated: .*/, `Last updated: ${now}`);
        await writeMd(path, content);
        return textResult(
          `Intention ${params.intention_id} committed (${params.strategy}) for '${params.agent_id}'`,
        );
      },
    },

    {
      name: "bdi_cycle",
      label: "BDI Reasoning Cycle",
      description:
        "Run a BDI cycle: PERCEIVE → DELIBERATE → PLAN → ACT → LEARN. Use 'quick' for heartbeat checks, 'full' for complete reasoning.",
      parameters: BdiCycleParams,
      async execute(_id: string, params: Static<typeof BdiCycleParams>) {
        const dir = agentDir(api, params.agent_id);
        const ws = resolveWorkspaceDir(api);

        if (params.depth === "quick") {
          const goals = await readMd(join(dir, "Goals.md"));
          const intentions = await readMd(join(dir, "Intentions.md"));
          return textResult(
            `## Quick BDI Check — ${params.agent_id}\n\n### Goals:\n${goals || "None."}\n\n### Intentions:\n${intentions || "None."}\n\nEvaluate: intentions progressing? goals need new plans? reconsideration triggers?`,
          );
        }

        // Full cycle — load all cognitive files
        const files: Record<string, string> = {};
        for (const f of [
          "Persona.md",
          "Capabilities.md",
          "Beliefs.md",
          "Desires.md",
          "Goals.md",
          "Intentions.md",
          "Plans.md",
          "Playbooks.md",
          "Knowledge.md",
          "Memory.md",
        ]) {
          files[f] = await readMd(join(dir, f));
        }

        return textResult(`## Full BDI Cycle — ${params.agent_id}

### PHASE 1: PERCEIVE
${files["Beliefs.md"] || "No beliefs."}

### PHASE 2: DELIBERATE
**Desires:** ${files["Desires.md"] || "None."}
**Goals:** ${files["Goals.md"] || "None."}

### PHASE 3: PLAN
**Playbooks:** ${files["Playbooks.md"] || "None."}
**Plans:** ${files["Plans.md"] || "None."}

### PHASE 4: ACT
**Intentions:** ${files["Intentions.md"] || "None."}
**Capabilities:** ${files["Capabilities.md"] || "None."}

### PHASE 5: LEARN
**Memory:** ${files["Memory.md"] || "None."}

Execute each phase. Write updates via belief_update, goal_create, intention_commit tools.`);
      },
    },

    {
      name: "skill_inventory",
      label: "Inventory Skills",
      description:
        "Read an agent's capabilities and available tools, then materialize a structured Skill.md file.",
      parameters: SkillInventoryParams,
      async execute(_id: string, params: Static<typeof SkillInventoryParams>) {
        const dir = agentDir(api, params.agent_id);

        // ── 1. Read Capabilities.md (existing behavior) ──
        const caps = await readMd(join(dir, "Capabilities.md"));
        let agentConfig: Record<string, unknown> = {};
        try {
          const raw = await readFile(join(dir, "agent.json"), "utf-8");
          agentConfig = JSON.parse(raw);
        } catch {
          // No config file
        }

        const capLines = caps
          .split("\n")
          .filter((l: string) => l.trim() && !l.startsWith("#"))
          .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
          .filter(Boolean);

        // ── 2. Scan workspace tools directory (existing behavior) ──
        const ws = resolveWorkspaceDir(api);
        let availableTools: string[] = [];
        try {
          const toolFiles = await readdir(join(ws, "tools"));
          availableTools = toolFiles
            .filter((f: string) => f.endsWith(".json") || f.endsWith(".ts") || f.endsWith(".js"))
            .map((f: string) => f.replace(/\.(json|ts|js)$/, ""));
        } catch {
          // No tools directory
        }

        // ── 3. Fetch OpenClaw skill snapshot (NEW) ──
        let openclawSkills: Array<{ name: string; primaryEnv?: string }> = [];
        try {
          const snapshot = api.getSkillSnapshot({ workspaceDir: ws });
          openclawSkills = snapshot.skills ?? [];
        } catch {
          // Skill snapshot unavailable — not critical
        }

        // ── 4. Build unified Skill.md ──
        const now = new Date().toISOString();

        // BDI/workspace skills from Capabilities.md
        const capRows = capLines.map((cap: string, i: number) => {
          const toolMatch = availableTools.find((t: string) =>
            cap.toLowerCase().includes(t.toLowerCase()),
          );
          return `| SK-${String(i + 1).padStart(3, "0")} | ${cap} | ${toolMatch || "—"} | active |`;
        });

        // OpenClaw platform skills
        const ocRows = openclawSkills.map((sk, i: number) => {
          const idx = capLines.length + i + 1;
          const envNote = sk.primaryEnv ? ` (${sk.primaryEnv})` : "";
          return `| SK-${String(idx).padStart(3, "0")} | ${sk.name}${envNote} | openclaw-skill | active |`;
        });

        let content = `# Skills — ${params.agent_id}

Last inventoried: ${now}

## Skill Registry

| ID | Skill | Tools | Status |
|---|---|---|---|
${capRows.join("\n")}
`;

        if (ocRows.length > 0) {
          content += `
## OpenClaw Skills

| ID | Skill | Source | Status |
|---|---|---|---|
${ocRows.join("\n")}
`;
        }

        content += `
## Notes

Skills auto-populated from Capabilities.md by \`skill_inventory\` tool.
Available workspace tools: ${availableTools.length > 0 ? availableTools.join(", ") : "none detected"}
OpenClaw eligible skills: ${openclawSkills.length > 0 ? openclawSkills.map((s) => s.name).join(", ") : "none"}
`;

        await writeMd(join(dir, "Skill.md"), content);
        return textResult(
          `Skill inventory created for '${params.agent_id}': ${capLines.length} capabilities, ${availableTools.length} workspace tools, ${openclawSkills.length} OpenClaw skills.`,
        );
      },
    },

    {
      name: "action_log",
      label: "Log Action",
      description:
        "Record an agent action in Actions.md with timestamp, tool used, task link, outcome, and summary.",
      parameters: ActionLogParams,
      async execute(_id: string, params: Static<typeof ActionLogParams>) {
        const dir = agentDir(api, params.agent_id);
        const path = join(dir, "Actions.md");
        const now = new Date().toISOString();

        let content = await readMd(path);
        if (!content) {
          content = `# Actions — ${params.agent_id}

## Recent Actions

| Timestamp | Tool | Task | Outcome | Summary |
|-----------|------|------|---------|---------|
`;
        }

        const row = `| ${now} | ${params.tool_name} | ${params.task_id || "—"} | ${params.outcome} | ${params.summary} |`;

        // Insert after the table header row
        const headerRow = "|-----------|------|------|---------|---------|";
        const headerIdx = content.indexOf(headerRow);
        if (headerIdx !== -1) {
          const insertAt = headerIdx + headerRow.length;
          content = content.slice(0, insertAt) + "\n" + row + content.slice(insertAt);
        } else {
          content += "\n" + row;
        }

        await writeMd(path, content);
        return textResult(
          `Action logged for '${params.agent_id}': ${params.tool_name} → ${params.outcome}`,
        );
      },
    },
  ];
}
