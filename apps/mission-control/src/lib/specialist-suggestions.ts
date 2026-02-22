import {
  listActivity,
  listMissions,
  listSpecialistFeedback,
  listTasks,
} from "@/lib/db";
import { listIntegrationSummaries } from "@/lib/integrations";
import { rankSpecialistsForTask } from "@/lib/specialist-intelligence";

export type SpecialistSuggestionChannel =
  | "learning_hub"
  | "workspace"
  | "openclaw";
export type SpecialistSuggestionPriority = "high" | "medium" | "low";

export interface SpecialistSuggestion {
  id: string;
  channel: SpecialistSuggestionChannel;
  title: string;
  summary: string;
  rationale: string;
  actions: string[];
  priority: SpecialistSuggestionPriority;
  confidence: number;
  specialistId: string;
  specialistName: string;
  specialistIcon: string;
  specialistColor: string;
  workspaceId: string | null;
  generatedAt: string;
}

export interface SpecialistSuggestionBundle {
  learning_hub: SpecialistSuggestion[];
  workspace: SpecialistSuggestion[];
  openclaw: SpecialistSuggestion[];
}

interface BuildSuggestionInput {
  channel: SpecialistSuggestionChannel;
  title: string;
  summary: string;
  rationale: string;
  actions: string[];
  priority: SpecialistSuggestionPriority;
  query: string;
  workspaceId?: string;
}

interface WorkspaceMetrics {
  workspaceId?: string;
  totalTasks: number;
  inboxTasks: number;
  reviewTasks: number;
  doneTasks: number;
  unassignedTasks: number;
  staleTasks: number;
  specialistTasks: number;
  missionCount: number;
  activeMissions: number;
  feedbackCount: number;
  reworkCount: number;
  integrationConfiguredCount: number;
}

interface PickedSpecialist {
  specialistId: string;
  specialistName: string;
  specialistIcon: string;
  specialistColor: string;
  confidence: number;
}

function buildWorkspaceMetrics(workspaceId?: string): WorkspaceMetrics {
  const tasks = workspaceId
    ? listTasks({ workspace_id: workspaceId })
    : listTasks({});
  const missions = workspaceId
    ? listMissions({ workspace_id: workspaceId })
    : listMissions({});
  const taskIds = new Set(tasks.map((task) => task.id));
  const now = Date.now();
  const staleMs = 1000 * 60 * 60 * 48;

  const feedbackRows = listSpecialistFeedback({ limit: 5000 }).filter((row) =>
    row.task_id ? taskIds.has(row.task_id) : !workspaceId
  );
  const reworkRows = listActivity({
    type: "task_rework",
    limit: 5000,
  }).filter((entry) => (entry.task_id ? taskIds.has(entry.task_id) : false));
  const integrationConfiguredCount = Object.values(
    listIntegrationSummaries()
  ).filter((row) => row.configured).length;

  return {
    workspaceId,
    totalTasks: tasks.length,
    inboxTasks: tasks.filter((task) => task.status === "inbox").length,
    reviewTasks: tasks.filter((task) => task.status === "review").length,
    doneTasks: tasks.filter((task) => task.status === "done").length,
    unassignedTasks: tasks.filter((task) => !task.assigned_agent_id).length,
    staleTasks: tasks.filter((task) => {
      if (task.status === "done") {return false;}
      const updated = new Date(task.updated_at).getTime();
      if (Number.isNaN(updated)) {return false;}
      return now - updated > staleMs;
    }).length,
    specialistTasks: tasks.filter((task) =>
      Boolean(task.assigned_agent_id && task.assigned_agent_id !== "main")
    ).length,
    missionCount: missions.length,
    activeMissions: missions.filter((mission) => mission.status === "active")
      .length,
    feedbackCount: feedbackRows.length,
    reworkCount: reworkRows.length,
    integrationConfiguredCount,
  };
}

function pickSpecialist(
  query: string,
  workspaceId?: string
): PickedSpecialist {
  const ranked = rankSpecialistsForTask(query, {
    limit: 1,
    workspaceId,
  })[0];
  if (ranked) {
    return {
      specialistId: ranked.agentId,
      specialistName: ranked.name,
      specialistIcon: ranked.icon,
      specialistColor: ranked.color,
      confidence: ranked.confidence,
    };
  }
  return {
    specialistId: "product-ideas-strategist",
    specialistName: "Product Ideas Strategist",
    specialistIcon: "Lightbulb",
    specialistColor: "text-yellow-400",
    confidence: 0.4,
  };
}

function buildSuggestion(input: BuildSuggestionInput): SpecialistSuggestion {
  const generatedAt = new Date().toISOString();
  const specialist = pickSpecialist(input.query, input.workspaceId);

  return {
    id: `${input.channel}:${specialist.specialistId}:${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    channel: input.channel,
    title: input.title,
    summary: input.summary,
    rationale: input.rationale,
    actions: input.actions.slice(0, 4),
    priority: input.priority,
    confidence: specialist.confidence,
    specialistId: specialist.specialistId,
    specialistName: specialist.specialistName,
    specialistIcon: specialist.specialistIcon,
    specialistColor: specialist.specialistColor,
    workspaceId: input.workspaceId ?? null,
    generatedAt,
  };
}

function buildLearningSuggestions(
  metrics: WorkspaceMetrics,
  workspaceId?: string
): SpecialistSuggestion[] {
  const suggestions: SpecialistSuggestion[] = [];
  const coverage =
    metrics.specialistTasks > 0
      ? metrics.feedbackCount / metrics.specialistTasks
      : 0;

  if (coverage < 0.5) {
    suggestions.push(
      buildSuggestion({
        channel: "learning_hub",
        title: "Launch Specialist Quality Calibration",
        summary:
          "Learning Hub should publish a recurring specialist calibration track from recent deliveries and feedback gaps.",
        rationale:
          "Feedback coverage is low, which limits specialist self-improvement and repeatable quality gains.",
        actions: [
          "Add a weekly 'specialist calibration' lesson in Learning Hub",
          "Capture top 3 recurring quality misses per specialist",
          "Attach one actionable checklist to each specialist profile",
        ],
        priority: "high",
        query:
          "learning curriculum quality calibration checklist specialist output quality",
        workspaceId,
      })
    );
  }

  if (metrics.reworkCount > 0) {
    suggestions.push(
      buildSuggestion({
        channel: "learning_hub",
        title: "Convert Rework Into Learning Modules",
        summary:
          "Turn rework loops into focused playbooks so specialists avoid repeating the same misses.",
        rationale:
          `${metrics.reworkCount} rework event(s) indicate concrete learning opportunities that can be codified.`,
        actions: [
          "Create one mini-lesson per recurring rework theme",
          "Link each lesson to a specialist action checklist",
          "Track rework reduction after lesson rollout",
        ],
        priority: "high",
        query: "rework reduction playbook specialist learning loop",
        workspaceId,
      })
    );
  }

  suggestions.push(
    buildSuggestion({
      channel: "learning_hub",
      title: "Publish 'What Great Looks Like' Specialist Guides",
      summary:
        "Promote top specialist behaviors into reusable Learning Hub guides across engineering workflows.",
      rationale:
        "A shared quality baseline helps specialists converge faster and improves cross-workspace consistency.",
      actions: [
        "Document high-impact specialist output patterns",
        "Add acceptance criteria examples per specialist domain",
        "Promote one guide each sprint as a default standard",
      ],
      priority: "medium",
      query: "specialist best practices guide acceptance criteria",
      workspaceId,
    })
  );

  return suggestions.slice(0, 3);
}

function buildWorkspaceSuggestions(
  metrics: WorkspaceMetrics,
  workspaceId?: string
): SpecialistSuggestion[] {
  const suggestions: SpecialistSuggestion[] = [];
  const workspaceLabel = workspaceId ?? "global";

  if (metrics.unassignedTasks > 0) {
    suggestions.push(
      buildSuggestion({
        channel: "workspace",
        title: "Close Unassigned Work Queue",
        summary:
          `${metrics.unassignedTasks} task(s) are unassigned in ${workspaceLabel}; specialists should proactively claim and route work.`,
        rationale:
          "Unassigned tasks are a primary source of delivery latency and fragmented ownership.",
        actions: [
          "Run daily specialist triage on unassigned tasks",
          "Use bulk assignment by capability match",
          "Escalate tasks without an owner beyond 24 hours",
        ],
        priority: "high",
        query: "task triage ownership assignment workflow reliability",
        workspaceId,
      })
    );
  }

  if (metrics.staleTasks > 0 || metrics.reviewTasks > 0) {
    suggestions.push(
      buildSuggestion({
        channel: "workspace",
        title: "Recover Stalled Specialist Flow",
        summary:
          `${metrics.staleTasks} stale task(s) and ${metrics.reviewTasks} review task(s) need a specialist recovery pass in ${workspaceLabel}.`,
        rationale:
          "Stalled work reduces confidence in specialist autonomy and slows feedback loops.",
        actions: [
          "Set review SLA with specialist-owner accountability",
          "Add stale-task watchdog activity for tasks >48h",
          "Trigger rework or done decision in one review cycle",
        ],
        priority: "high",
        query: "workflow bottleneck review SLA stale tasks recovery",
        workspaceId,
      })
    );
  }

  if (metrics.activeMissions === 0) {
    suggestions.push(
      buildSuggestion({
        channel: "workspace",
        title: "Map Specialists to Active Missions",
        summary:
          "Create mission-scoped specialist ownership so work is aligned to clear outcomes in this workspace.",
        rationale:
          "Without active missions, specialists optimize locally and roadmap progress becomes hard to measure.",
        actions: [
          "Create one active mission per major objective",
          "Assign a lead specialist per mission",
          "Publish mission health checks in weekly review",
        ],
        priority: "medium",
        query: "mission planning ownership specialist roadmap",
        workspaceId,
      })
    );
  }

  suggestions.push(
    buildSuggestion({
      channel: "workspace",
      title: "Establish Workspace Specialist Scorecard",
      summary:
        "Track quality, cycle time, and rework by specialist for this workspace to guide prioritization.",
      rationale:
        "A shared scorecard keeps specialists accountable and makes improvements explicit.",
      actions: [
        "Track quality score trend per specialist weekly",
        "Highlight top two improvement areas each cycle",
        "Review scorecard in workspace planning rituals",
      ],
      priority: "medium",
      query: "scorecard quality trend cycle time specialist workspace",
      workspaceId,
    })
  );

  return suggestions.slice(0, 3);
}

function buildOpenclawSuggestions(
  metrics: WorkspaceMetrics,
  workspaceId?: string
): SpecialistSuggestion[] {
  const suggestions: SpecialistSuggestion[] = [];

  if (metrics.integrationConfiguredCount < 2) {
    suggestions.push(
      buildSuggestion({
        channel: "openclaw",
        title: "Raise Integration Reliability Baseline",
        summary:
          "OpenClaw should improve default integration readiness, token diagnostics, and fallback UX for all workspaces.",
        rationale:
          "Low integration coverage limits specialist effectiveness and end-to-end automation value.",
        actions: [
          "Add guided integration setup checks",
          "Add structured integration health diagnostics",
          "Add fallback behavior when external services are unavailable",
        ],
        priority: "high",
        query: "integration reliability fallback diagnostics external services",
        workspaceId,
      })
    );
  }

  if (metrics.feedbackCount < Math.max(3, Math.floor(metrics.totalTasks / 2))) {
    suggestions.push(
      buildSuggestion({
        channel: "openclaw",
        title: "Strengthen Specialist Feedback Signals",
        summary:
          "OpenClaw should collect stronger quality signals so specialists learn continuously from outcomes.",
        rationale:
          "Sparse feedback weakens ranking precision and slows specialist adaptation.",
        actions: [
          "Prompt feedback at every review->done transition",
          "Add quality trend alerts for declining specialists",
          "Expose feedback coverage metrics in specialist dashboard",
        ],
        priority: "high",
        query: "quality feedback loop specialist intelligence adaptive ranking",
        workspaceId,
      })
    );
  }

  suggestions.push(
    buildSuggestion({
      channel: "openclaw",
      title: "Launch Weekly Specialist Improvement Council",
      summary:
        "Create a recurring OpenClaw improvement cycle where specialists propose top platform upgrades.",
      rationale:
        "A formal proposal loop turns specialist insights into product-level improvements consistently.",
      actions: [
        "Collect weekly top 5 specialist improvement proposals",
        "Score proposals by impact and implementation effort",
        "Ship the highest value proposal every sprint",
      ],
      priority: "medium",
      query: "platform improvement council specialist proposals roadmap",
      workspaceId,
    })
  );

  return suggestions.slice(0, 3);
}

export function buildSpecialistSuggestionBundle(opts?: {
  workspaceId?: string;
}): SpecialistSuggestionBundle {
  const metrics = buildWorkspaceMetrics(opts?.workspaceId);
  return {
    learning_hub: buildLearningSuggestions(metrics, opts?.workspaceId),
    workspace: buildWorkspaceSuggestions(metrics, opts?.workspaceId),
    openclaw: buildOpenclawSuggestions(metrics, opts?.workspaceId),
  };
}
