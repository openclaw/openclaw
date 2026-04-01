/**
 * Director Orchestrator — Goal→Plan→Task→Action Pipeline
 *
 * Reads all agent Goals.md files, generates Plans with HTN-decomposed steps,
 * creates Task entries, assigns to subagents, and syncs to TypeDB.
 *
 * Usage: npx tsx scripts/director-orchestrator.ts [--dry-run] [--agent <id>]
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ── Configuration ───────────────────────────────────────────────────────

const TEMPLATES_DIR = join(
  dirname(import.meta.url.replace("file://", "")),
  "..",
  "templates",
  "base",
  "agents",
);
const WORKSPACE_DIR = join(dirname(import.meta.url.replace("file://", "")), "..", "workspace");
const DB_NAME = "mabos";
const NOW = new Date().toISOString();
const TODAY = NOW.split("T")[0];

const DRY_RUN = process.argv.includes("--dry-run");
const AGENT_FILTER = process.argv.includes("--agent")
  ? process.argv[process.argv.indexOf("--agent") + 1]
  : null;

// ── Agent capability mapping for task assignment ────────────────────────

interface AgentCapability {
  id: string;
  name: string;
  domains: string[];
  subagents: string[];
}

const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    id: "ceo",
    name: "CEO Agent",
    domains: [
      "strategy",
      "coordination",
      "stakeholder",
      "oversight",
      "alignment",
      "cross-functional",
    ],
    subagents: ["cfo", "cmo", "coo", "cto", "legal", "strategy", "knowledge", "hr"],
  },
  {
    id: "cfo",
    name: "CFO Agent",
    domains: [
      "finance",
      "revenue",
      "cost",
      "budget",
      "pricing",
      "margin",
      "EBITDA",
      "P&L",
      "forecast",
      "cash flow",
      "unit economics",
      "tax",
    ],
    subagents: [],
  },
  {
    id: "cmo",
    name: "CMO Agent",
    domains: [
      "marketing",
      "brand",
      "acquisition",
      "conversion",
      "SEO",
      "content",
      "social",
      "email",
      "advertising",
      "campaign",
      "persona",
      "segment",
    ],
    subagents: ["lead-gen", "sales-research", "outreach", "ecommerce"],
  },
  {
    id: "coo",
    name: "COO Agent",
    domains: [
      "operations",
      "fulfillment",
      "supply chain",
      "quality",
      "shipping",
      "inventory",
      "automation",
      "vendor",
      "Pictorem",
      "print",
    ],
    subagents: [],
  },
  {
    id: "cto",
    name: "CTO Agent",
    domains: [
      "technology",
      "infrastructure",
      "platform",
      "API",
      "database",
      "AI/ML",
      "AR",
      "security",
      "monitoring",
      "uptime",
      "deployment",
    ],
    subagents: [],
  },
  {
    id: "legal",
    name: "Legal Agent",
    domains: [
      "legal",
      "compliance",
      "IP",
      "trademark",
      "copyright",
      "GDPR",
      "terms",
      "privacy",
      "contracts",
    ],
    subagents: [],
  },
  {
    id: "strategy",
    name: "Strategy Agent",
    domains: [
      "competitive",
      "market research",
      "positioning",
      "opportunity",
      "analysis",
      "SWOT",
      "industry",
    ],
    subagents: [],
  },
  {
    id: "knowledge",
    name: "Knowledge Agent",
    domains: ["knowledge", "ontology", "TypeDB", "documentation", "training", "learning"],
    subagents: [],
  },
  {
    id: "hr",
    name: "HR Agent",
    domains: ["performance", "agent management", "onboarding", "skills", "workforce"],
    subagents: [],
  },
  {
    id: "ecommerce",
    name: "E-Commerce Agent",
    domains: ["Shopify", "storefront", "product page", "checkout", "cart", "catalog", "collection"],
    subagents: [],
  },
  {
    id: "lead-gen",
    name: "Lead Generation Agent",
    domains: ["lead", "prospect", "pipeline", "outbound", "cold outreach"],
    subagents: [],
  },
  {
    id: "sales-research",
    name: "Sales Research Agent",
    domains: ["ICP", "buyer persona", "competitive intelligence", "market sizing"],
    subagents: [],
  },
  {
    id: "outreach",
    name: "Outreach Agent",
    domains: ["outreach", "email sequence", "follow-up", "personalization", "response tracking"],
    subagents: [],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

async function readMd(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function writeMd(p: string, c: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}

function findBestAgent(description: string, ownerAgent: string): string {
  const lower = description.toLowerCase();
  let bestMatch = ownerAgent;
  let bestScore = 0;

  for (const agent of AGENT_CAPABILITIES) {
    if (agent.id === ownerAgent) continue;
    let score = 0;
    for (const domain of agent.domains) {
      if (lower.includes(domain.toLowerCase())) {
        score += domain.length; // Longer domain matches = more specific
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = agent.id;
    }
  }
  return bestMatch;
}

// ── Goal Parser ─────────────────────────────────────────────────────────

interface ParsedGoal {
  id: string;
  description: string;
  level: "delegated" | "strategic" | "tactical" | "operational" | "learning";
  priority: number;
  deadline?: string;
  successCriteria?: string;
  status?: string;
  parentGoal?: string;
}

function parseGoals(content: string): ParsedGoal[] {
  const goals: ParsedGoal[] = [];
  const lines = content.split("\n");
  let currentLevel: ParsedGoal["level"] = "strategic";
  let currentGoal: Partial<ParsedGoal> | null = null;

  for (const line of lines) {
    // Detect section headers
    if (line.includes("Delegated Goals")) currentLevel = "delegated";
    else if (line.includes("Strategic Goals")) currentLevel = "strategic";
    else if (line.includes("Tactical Goals")) currentLevel = "tactical";
    else if (line.includes("Operational Goals")) currentLevel = "operational";
    else if (line.includes("Learning")) currentLevel = "learning";

    // Parse goal entries (- **ID**: description format)
    const goalMatch = line.match(/^\s*-\s+\*\*([A-Z0-9-]+)\*\*:\s*(.+)/);
    if (goalMatch) {
      if (currentGoal && currentGoal.id) {
        goals.push(currentGoal as ParsedGoal);
      }
      currentGoal = {
        id: goalMatch[1],
        description: goalMatch[2].trim(),
        level: currentLevel,
        priority:
          currentLevel === "delegated"
            ? 0.95
            : currentLevel === "strategic"
              ? 0.85
              : currentLevel === "tactical"
                ? 0.8
                : currentLevel === "operational"
                  ? 0.75
                  : 0.7,
      };
      continue;
    }

    // Parse goal properties
    if (currentGoal && line.match(/^\s+-/)) {
      const priorityMatch = line.match(/Priority:\s*([\d.]+|Critical|High|Medium|Low)/i);
      if (priorityMatch) {
        const pv = priorityMatch[1];
        currentGoal.priority =
          pv === "Critical"
            ? 0.95
            : pv === "High"
              ? 0.85
              : pv === "Medium"
                ? 0.7
                : pv === "Low"
                  ? 0.5
                  : parseFloat(pv) || 0.75;
      }
      const deadlineMatch = line.match(/Deadline:\s*(.+)/);
      if (deadlineMatch) currentGoal.deadline = deadlineMatch[1].trim();
      const criteriaMatch = line.match(/Success criteria:\s*(.+)/);
      if (criteriaMatch) currentGoal.successCriteria = criteriaMatch[1].trim();
      const statusMatch = line.match(/Status:\s*(.+)/);
      if (statusMatch) currentGoal.status = statusMatch[1].trim();
    }

    // Parse ### format goals (e.g., ### G-CEO-S1: description)
    const h3Match = line.match(/^###\s+([A-Z0-9-]+):\s*(.+)/);
    if (h3Match) {
      if (currentGoal && currentGoal.id) {
        goals.push(currentGoal as ParsedGoal);
      }
      currentGoal = {
        id: h3Match[1],
        description: h3Match[2].trim(),
        level: currentLevel,
        priority: 0.8,
      };
    }
  }

  if (currentGoal && currentGoal.id) {
    goals.push(currentGoal as ParsedGoal);
  }

  return goals;
}

// ── Plan Generator ──────────────────────────────────────────────────────

interface PlanStep {
  id: string;
  description: string;
  type: "primitive" | "compound";
  assignedTo: string;
  dependsOn: string[];
  estimatedDuration: string;
  tool?: string;
}

interface GeneratedPlan {
  id: string;
  name: string;
  goalId: string;
  confidence: number;
  strategy: string;
  steps: PlanStep[];
}

function generatePlanForGoal(goal: ParsedGoal, agentId: string): GeneratedPlan {
  const planId = `P-${agentId.toUpperCase()}-${goal.id.replace(/[^A-Z0-9]/gi, "")}`;
  const steps: PlanStep[] = [];

  // HTN decomposition based on goal level and description
  if (goal.level === "delegated" || goal.level === "strategic") {
    // Strategic/delegated goals get full decomposition
    steps.push({
      id: `${planId}-S1`,
      description: `Assess current state and baseline for: ${goal.description}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [],
      estimatedDuration: "2h",
      tool: "belief_get",
    });
    steps.push({
      id: `${planId}-S2`,
      description: `Identify gaps between current state and target: ${goal.successCriteria || goal.description}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S1`],
      estimatedDuration: "1h",
      tool: "goal_evaluate",
    });
    steps.push({
      id: `${planId}-S3`,
      description: `Develop action items and assign to subagents for: ${goal.description}`,
      type: "compound",
      assignedTo: agentId,
      dependsOn: [`${planId}-S2`],
      estimatedDuration: "2h",
      tool: "directive_decompose",
    });
    steps.push({
      id: `${planId}-S4`,
      description: `Execute primary workstreams for: ${goal.description}`,
      type: "compound",
      assignedTo: findBestAgent(goal.description, agentId),
      dependsOn: [`${planId}-S3`],
      estimatedDuration: "ongoing",
    });
    steps.push({
      id: `${planId}-S5`,
      description: `Monitor progress and adjust: track ${goal.successCriteria || "KPIs"} weekly`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S4`],
      estimatedDuration: "1h/week",
      tool: "goal_progress_update",
    });
    steps.push({
      id: `${planId}-S6`,
      description: `Report results and lessons learned for: ${goal.id}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S5`],
      estimatedDuration: "1h",
      tool: "action_log",
    });
  } else if (goal.level === "tactical") {
    steps.push({
      id: `${planId}-S1`,
      description: `Review requirements and dependencies for: ${goal.description}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [],
      estimatedDuration: "1h",
    });
    steps.push({
      id: `${planId}-S2`,
      description: `Create deliverables/artifacts for: ${goal.description}`,
      type: "compound",
      assignedTo: findBestAgent(goal.description, agentId),
      dependsOn: [`${planId}-S1`],
      estimatedDuration: "4h",
    });
    steps.push({
      id: `${planId}-S3`,
      description: `Review and validate outputs against: ${goal.successCriteria || goal.description}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S2`],
      estimatedDuration: "1h",
      tool: "goal_evaluate",
    });
    steps.push({
      id: `${planId}-S4`,
      description: `Update progress tracking for: ${goal.id}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S3`],
      estimatedDuration: "30m",
      tool: "goal_progress_update",
    });
  } else if (goal.level === "operational") {
    steps.push({
      id: `${planId}-S1`,
      description: `Execute routine: ${goal.description}`,
      type: "primitive",
      assignedTo: findBestAgent(goal.description, agentId),
      dependsOn: [],
      estimatedDuration: "1h",
    });
    steps.push({
      id: `${planId}-S2`,
      description: `Verify completion and log results for: ${goal.id}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S1`],
      estimatedDuration: "15m",
      tool: "action_log",
    });
  } else {
    // Learning goals
    steps.push({
      id: `${planId}-S1`,
      description: `Research and study: ${goal.description}`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [],
      estimatedDuration: "4h",
    });
    steps.push({
      id: `${planId}-S2`,
      description: `Practice and apply learning to VividWalls context`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S1`],
      estimatedDuration: "2h",
    });
    steps.push({
      id: `${planId}-S3`,
      description: `Document learnings and update Knowledge.md`,
      type: "primitive",
      assignedTo: agentId,
      dependsOn: [`${planId}-S2`],
      estimatedDuration: "1h",
      tool: "action_log",
    });
  }

  return {
    id: planId,
    name: `Plan: ${goal.description.slice(0, 80)}`,
    goalId: goal.id,
    confidence: goal.level === "delegated" ? 0.85 : goal.level === "strategic" ? 0.8 : 0.9,
    strategy: `HTN-decomposed plan for ${goal.level} goal: ${goal.description.slice(0, 100)}`,
    steps,
  };
}

// ── Plans.md Generator ──────────────────────────────────────────────────

function generatePlansMarkdown(agentId: string, agentName: string, plans: GeneratedPlan[]): string {
  let md = `# Plans — ${agentName}\n\nLast updated: ${NOW}\nGenerated by: Director Orchestrator\n\n## Active Plans\n`;

  for (const plan of plans) {
    const stepsTable = plan.steps
      .map(
        (s) =>
          `| ${s.id} | ${s.description} | ${s.type} | ${s.assignedTo} | ${s.dependsOn.join(", ") || "—"} | pending | ${s.estimatedDuration} |`,
      )
      .join("\n");

    md += `\n### ${plan.id}: ${plan.name}
- **Goal:** ${plan.goalId}
- **Source:** htn-generated
- **Status:** active
- **Confidence:** ${plan.confidence}
- **Strategy:** ${plan.strategy}
- **Created:** ${TODAY}

#### Steps (HTN Decomposition)

| Step | Description | Type | Assigned | Depends On | Status | Est. Duration |
|---|---|---|---|---|---|---|
${stepsTable}

`;
  }

  md += `\n## Completed Plans\n\n| ID | Plan | Goal | Completed | Outcome |\n|---|---|---|---|---|\n\n## Archived Plans\n\n| ID | Plan | Reason |\n|---|---|---|\n`;

  return md;
}

// ── Task.md Generator ───────────────────────────────────────────────────

interface TaskEntry {
  id: string;
  description: string;
  goalId: string;
  priority: number;
  status: string;
  assignedTo: string;
  planId: string;
  stepId: string;
}

function generateTasksFromPlans(
  agentId: string,
  plans: GeneratedPlan[],
  goals: ParsedGoal[],
): TaskEntry[] {
  const tasks: TaskEntry[] = [];
  let taskNum = 1;

  for (const plan of plans) {
    const goal = goals.find((g) => g.id === plan.goalId);
    const priority = goal?.priority || 0.75;

    for (const step of plan.steps) {
      if (step.type === "primitive") {
        tasks.push({
          id: `T-${agentId.toUpperCase()}-${String(taskNum).padStart(3, "0")}`,
          description: step.description,
          goalId: plan.goalId,
          priority,
          status: "pending",
          assignedTo: step.assignedTo,
          planId: plan.id,
          stepId: step.id,
        });
        taskNum++;
      }
    }
  }
  return tasks;
}

function generateTasksMarkdown(agentId: string, agentName: string, tasks: TaskEntry[]): string {
  const activeRows = tasks
    .map(
      (t) =>
        `| ${t.id} | ${t.description.slice(0, 80)} | ${t.goalId} | ${t.priority.toFixed(2)} | ${t.status} | ${t.assignedTo} |`,
    )
    .join("\n");

  return `# Tasks — ${agentName}

Last updated: ${NOW}
Generated by: Director Orchestrator

## Active Tasks

| ID | Task | Goal | Priority | Status | Assigned |
|---|---|---|---|---|---|
${activeRows}

## Completed Tasks

| ID | Task | Completed | Outcome |
|---|---|---|---|
`;
}

// ── TypeDB Sync ─────────────────────────────────────────────────────────

interface TypeDBSyncResult {
  goals: number;
  plans: number;
  planSteps: number;
  tasks: number;
  goalPlanLinks: number;
  planStepLinks: number;
  errors: string[];
}

async function syncToTypeDB(
  agentId: string,
  goals: ParsedGoal[],
  plans: GeneratedPlan[],
  tasks: TaskEntry[],
): Promise<TypeDBSyncResult> {
  const result: TypeDBSyncResult = {
    goals: 0,
    plans: 0,
    planSteps: 0,
    tasks: 0,
    goalPlanLinks: 0,
    planStepLinks: 0,
    errors: [],
  };

  let client: any;
  try {
    const { getTypeDBClient } = await import("../src/knowledge/typedb-client.js");
    client = getTypeDBClient();
    if (!client.isAvailable()) {
      const connected = await client.connect();
      if (!connected) {
        result.errors.push("TypeDB not available — file-based sync only");
        return result;
      }
    }
    await client.ensureDatabase(DB_NAME);
  } catch (e) {
    result.errors.push(`TypeDB connection failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  const vwAgentId = `vw-${agentId}`;

  // Ensure agent exists
  try {
    await client.insertData(
      `insert $agent isa agent, has uid ${JSON.stringify(vwAgentId)}, has name ${JSON.stringify(agentId + " Agent")};`,
      DB_NAME,
    );
  } catch {
    /* agent may already exist */
  }

  // 1. Sync goals
  for (const goal of goals) {
    try {
      const optionals = [
        goal.successCriteria
          ? `, has success_criteria ${JSON.stringify(goal.successCriteria)}`
          : "",
        goal.deadline ? `, has deadline ${JSON.stringify(goal.deadline)}` : "",
      ].join("");

      await client.insertData(
        `match $agent isa agent, has uid ${JSON.stringify(vwAgentId)};
insert $goal isa goal, has uid ${JSON.stringify(goal.id)}, has name ${JSON.stringify(goal.description.slice(0, 200))}, has description ${JSON.stringify(goal.description)}, has hierarchy_level ${JSON.stringify(goal.level)}, has priority ${goal.priority}, has status ${JSON.stringify(goal.status || "active")}, has progress 0.0${optionals}, has created_at ${JSON.stringify(NOW)}, has updated_at ${JSON.stringify(NOW)}; (owner: $agent, owned: $goal) isa agent_owns;`,
        DB_NAME,
      );
      result.goals++;
    } catch (e) {
      result.errors.push(`Goal ${goal.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Sync plans
  for (const plan of plans) {
    try {
      await client.insertData(
        `match $agent isa agent, has uid ${JSON.stringify(vwAgentId)};
insert $plan isa plan, has uid ${JSON.stringify(plan.id)}, has name ${JSON.stringify(plan.name.slice(0, 200))}, has description ${JSON.stringify(plan.strategy)}, has plan_source "htn-generated", has step_count ${plan.steps.length}, has confidence ${plan.confidence}, has status "active", has created_at ${JSON.stringify(NOW)}, has updated_at ${JSON.stringify(NOW)}; (owner: $agent, owned: $plan) isa agent_owns;`,
        DB_NAME,
      );
      result.plans++;
    } catch (e) {
      result.errors.push(`Plan ${plan.id}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Link goal → plan
    try {
      await client.insertData(
        `match $agent isa agent, has uid ${JSON.stringify(vwAgentId)}; $goal isa goal, has uid ${JSON.stringify(plan.goalId)}; $plan isa plan, has uid ${JSON.stringify(plan.id)}; (owner: $agent, owned: $goal) isa agent_owns; insert (requiring: $goal, required: $plan) isa goal_requires_plan;`,
        DB_NAME,
      );
      result.goalPlanLinks++;
    } catch (e) {
      result.errors.push(
        `Link ${plan.goalId}→${plan.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 3. Sync plan steps
    for (const step of plan.steps) {
      try {
        const toolClause = step.tool ? `, has tool_binding ${JSON.stringify(step.tool)}` : "";
        await client.insertData(
          `match $agent isa agent, has uid ${JSON.stringify(vwAgentId)};
insert $ps isa plan_step, has uid ${JSON.stringify(step.id)}, has name ${JSON.stringify(step.description.slice(0, 200))}, has step_type ${JSON.stringify(step.type)}, has estimated_duration ${JSON.stringify(step.estimatedDuration)}, has status "pending", has sequence_order ${plan.steps.indexOf(step) + 1}${toolClause}, has created_at ${JSON.stringify(NOW)}; (owner: $agent, owned: $ps) isa agent_owns;`,
          DB_NAME,
        );
        result.planSteps++;
      } catch (e) {
        result.errors.push(`Step ${step.id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Link plan → step
      try {
        await client.insertData(
          `match $plan isa plan, has uid ${JSON.stringify(plan.id)}; $step isa plan_step, has uid ${JSON.stringify(step.id)}; insert (container: $plan, contained: $step) isa plan_contains_step;`,
          DB_NAME,
        );
        result.planStepLinks++;
      } catch (e) {
        result.errors.push(
          `Link ${plan.id}→${step.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // 4. Sync tasks
  for (const task of tasks) {
    try {
      const assignedClause = task.assignedTo
        ? `, has assigned_agent_id ${JSON.stringify("vw-" + task.assignedTo)}`
        : "";
      await client.insertData(
        `match $agent isa agent, has uid ${JSON.stringify(vwAgentId)};
insert $task isa task, has uid ${JSON.stringify(task.id)}, has name ${JSON.stringify(task.description.slice(0, 200))}, has description ${JSON.stringify(task.description)}, has task_type "plan-derived", has priority ${task.priority}, has status "pending"${assignedClause}, has estimated_duration "1h", has created_at ${JSON.stringify(NOW)}, has updated_at ${JSON.stringify(NOW)}; (owner: $agent, owned: $task) isa agent_owns;`,
        DB_NAME,
      );
      result.tasks++;
    } catch (e) {
      result.errors.push(`Task ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

// ── Director Agent: Dispatch Tasks to Subagents via Inbox ───────────────

async function dispatchTasksToSubagents(agentId: string, tasks: TaskEntry[]): Promise<number> {
  let dispatched = 0;
  const wsDir = WORKSPACE_DIR;

  // Group tasks by assigned agent
  const tasksByAgent = new Map<string, TaskEntry[]>();
  for (const task of tasks) {
    if (task.assignedTo !== agentId) {
      const existing = tasksByAgent.get(task.assignedTo) || [];
      existing.push(task);
      tasksByAgent.set(task.assignedTo, existing);
    }
  }

  for (const [targetAgent, agentTasks] of tasksByAgent) {
    const inboxPath = join(wsDir, "agents", targetAgent, "inbox.json");
    let inbox: any[] = [];
    try {
      inbox = JSON.parse(await readFile(inboxPath, "utf-8"));
    } catch {
      /* empty inbox */
    }

    for (const task of agentTasks) {
      const msgId = `TASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      inbox.push({
        id: msgId,
        from: agentId,
        to: targetAgent,
        performative: "REQUEST",
        content: `[Task Assignment] ${task.id}: ${task.description}`,
        priority: task.priority >= 0.9 ? "urgent" : task.priority >= 0.8 ? "high" : "normal",
        timestamp: NOW,
        read: false,
        task_id: task.id,
        goal_id: task.goalId,
        plan_id: task.planId,
      });
      dispatched++;
    }

    await mkdir(dirname(inboxPath), { recursive: true });
    await writeFile(inboxPath, JSON.stringify(inbox, null, 2), "utf-8");
  }

  return dispatched;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Director Orchestrator — Goal→Plan→Task→Action  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\nTimestamp: ${NOW}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  if (AGENT_FILTER) console.log(`Agent filter: ${AGENT_FILTER}`);
  console.log("");

  // Get all agent directories
  let agents: string[];
  try {
    agents = await readdir(TEMPLATES_DIR);
  } catch (e) {
    console.error(`Cannot read templates dir: ${TEMPLATES_DIR}`);
    process.exit(1);
  }

  if (AGENT_FILTER) {
    agents = agents.filter((a) => a === AGENT_FILTER);
    if (agents.length === 0) {
      console.error(`Agent "${AGENT_FILTER}" not found`);
      process.exit(1);
    }
  }

  const agentNames: Record<string, string> = {
    ceo: "CEO (Chief Executive Officer)",
    cfo: "CFO (Chief Financial Officer)",
    cmo: "CMO (Chief Marketing Officer)",
    coo: "COO (Chief Operations Officer)",
    cto: "CTO (Chief Technology Officer)",
    legal: "Legal Agent",
    strategy: "Strategy Agent",
    knowledge: "Knowledge Agent",
    hr: "HR Agent",
    ecommerce: "E-Commerce Agent",
    "lead-gen": "Lead Generation Agent",
    "sales-research": "Sales Research Agent",
    outreach: "Outreach Agent",
  };

  const totals = {
    agents: 0,
    goals: 0,
    plans: 0,
    tasks: 0,
    dispatched: 0,
    typedb: {
      goals: 0,
      plans: 0,
      planSteps: 0,
      tasks: 0,
      goalPlanLinks: 0,
      planStepLinks: 0,
      errors: [] as string[],
    },
  };

  for (const agentId of agents) {
    const agentName = agentNames[agentId] || agentId;
    const goalsPath = join(TEMPLATES_DIR, agentId, "Goals.md");

    console.log(`\n${"═".repeat(60)}`);
    console.log(`Agent: ${agentName} (${agentId})`);
    console.log("═".repeat(60));

    // 1. Parse goals
    const goalsContent = await readMd(goalsPath);
    if (!goalsContent) {
      console.log("  ⚠  No Goals.md found, skipping");
      continue;
    }

    const goals = parseGoals(goalsContent);
    console.log(`  Goals parsed: ${goals.length}`);
    console.log(`    Delegated: ${goals.filter((g) => g.level === "delegated").length}`);
    console.log(`    Strategic: ${goals.filter((g) => g.level === "strategic").length}`);
    console.log(`    Tactical: ${goals.filter((g) => g.level === "tactical").length}`);
    console.log(`    Operational: ${goals.filter((g) => g.level === "operational").length}`);
    console.log(`    Learning: ${goals.filter((g) => g.level === "learning").length}`);

    // 2. Generate plans for each goal
    const plans = goals.map((goal) => generatePlanForGoal(goal, agentId));
    console.log(`  Plans generated: ${plans.length}`);
    console.log(`    Total steps: ${plans.reduce((a, p) => a + p.steps.length, 0)}`);

    // 3. Generate tasks from plans
    const tasks = generateTasksFromPlans(agentId, plans, goals);
    console.log(`  Tasks created: ${tasks.length}`);
    const delegatedTasks = tasks.filter((t) => t.assignedTo !== agentId);
    console.log(`    Self-assigned: ${tasks.length - delegatedTasks.length}`);
    console.log(`    Delegated to subagents: ${delegatedTasks.length}`);

    if (!DRY_RUN) {
      // 4. Write Plans.md
      const plansPath = join(TEMPLATES_DIR, agentId, "Plans.md");
      const plansMd = generatePlansMarkdown(agentId, agentName, plans);
      await writeMd(plansPath, plansMd);
      console.log(`  ✓ Plans.md written (${plansMd.length} bytes)`);

      // 5. Write Task.md
      const tasksPath = join(TEMPLATES_DIR, agentId, "Task.md");
      const tasksMd = generateTasksMarkdown(agentId, agentName, tasks);
      await writeMd(tasksPath, tasksMd);
      console.log(`  ✓ Task.md written (${tasksMd.length} bytes)`);

      // 6. Dispatch tasks to subagent inboxes
      const dispatched = await dispatchTasksToSubagents(agentId, tasks);
      if (dispatched > 0) {
        console.log(`  ✓ ${dispatched} tasks dispatched to subagent inboxes`);
      }
      totals.dispatched += dispatched;

      // 7. Sync to TypeDB
      console.log("  Syncing to TypeDB...");
      const typedbResult = await syncToTypeDB(agentId, goals, plans, tasks);
      console.log(`    Goals: ${typedbResult.goals}/${goals.length}`);
      console.log(`    Plans: ${typedbResult.plans}/${plans.length}`);
      console.log(
        `    Plan Steps: ${typedbResult.planSteps}/${plans.reduce((a, p) => a + p.steps.length, 0)}`,
      );
      console.log(`    Tasks: ${typedbResult.tasks}/${tasks.length}`);
      console.log(`    Goal→Plan links: ${typedbResult.goalPlanLinks}`);
      console.log(`    Plan→Step links: ${typedbResult.planStepLinks}`);
      if (typedbResult.errors.length > 0) {
        console.log(`    ⚠ Errors: ${typedbResult.errors.length}`);
        typedbResult.errors.slice(0, 3).forEach((e) => console.log(`      - ${e}`));
      }

      // Accumulate TypeDB totals
      totals.typedb.goals += typedbResult.goals;
      totals.typedb.plans += typedbResult.plans;
      totals.typedb.planSteps += typedbResult.planSteps;
      totals.typedb.tasks += typedbResult.tasks;
      totals.typedb.goalPlanLinks += typedbResult.goalPlanLinks;
      totals.typedb.planStepLinks += typedbResult.planStepLinks;
      totals.typedb.errors.push(...typedbResult.errors);
    } else {
      console.log("  [DRY RUN] Would write Plans.md, Task.md, dispatch tasks, and sync to TypeDB");
    }

    totals.agents++;
    totals.goals += goals.length;
    totals.plans += plans.length;
    totals.tasks += tasks.length;
  }

  // ── Summary ─────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(60)}`);
  console.log("SUMMARY");
  console.log("═".repeat(60));
  console.log(`Agents processed: ${totals.agents}`);
  console.log(`Goals parsed: ${totals.goals}`);
  console.log(`Plans generated: ${totals.plans}`);
  console.log(`Tasks created: ${totals.tasks}`);
  console.log(`Tasks dispatched to subagents: ${totals.dispatched}`);

  if (!DRY_RUN) {
    console.log(`\nTypeDB Sync:`);
    console.log(`  Goals: ${totals.typedb.goals}`);
    console.log(`  Plans: ${totals.typedb.plans}`);
    console.log(`  Plan Steps: ${totals.typedb.planSteps}`);
    console.log(`  Tasks: ${totals.typedb.tasks}`);
    console.log(`  Goal→Plan links: ${totals.typedb.goalPlanLinks}`);
    console.log(`  Plan→Step links: ${totals.typedb.planStepLinks}`);
    if (totals.typedb.errors.length > 0) {
      console.log(`  Errors: ${totals.typedb.errors.length}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
