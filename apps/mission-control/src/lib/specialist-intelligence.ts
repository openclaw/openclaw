import {
  listActivity,
  listSpecialistFeedback,
  listTasks,
  type SpecialistFeedback,
  type Task,
} from "@/lib/db";
import {
  getSpecializedAgents,
  type SpecializedAgent,
} from "@/lib/agent-registry";

export type SpecialistTrend = "improving" | "steady" | "needs_attention";

export interface SpecialistIntelligenceSnapshot {
  specialistId: string;
  qualityScore: number;
  confidence: number;
  trend: SpecialistTrend;
  approvalRate: number;
  reworkRate: number;
  avgCycleMinutes: number;
  avgFeedbackRating: number | null;
  feedbackCount: number;
  tasksAssigned: number;
  tasksDone: number;
  tasksInReview: number;
  activeTasks: number;
  strengths: string[];
  improvementFocus: string;
  generatedAt: string;
}

export interface SpecialistRecommendation {
  agentId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  score: number;
  confidence: number;
  reasons: string[];
  intelligence: SpecialistIntelligenceSnapshot;
  available: boolean;
}

interface IntelligenceBuildContext {
  tasksByAgent: Map<string, Task[]>;
  feedbackByAgent: Map<string, SpecialistFeedback[]>;
  reworkTaskIdsByAgent: Map<string, Set<string>>;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "about",
  "task",
  "needs",
  "need",
  "work",
  "agent",
  "specialist",
  "please",
  "make",
  "build",
  "create",
  "improve",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function round(value: number, decimals = 2): number {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) => token.length > 2 && !STOP_WORDS.has(token)
    );
}

function buildTrend(
  doneTasks: Task[],
  feedback: SpecialistFeedback[]
): SpecialistTrend {
  const recentDone = doneTasks.slice(-8);
  const olderDone = doneTasks.slice(-16, -8);
  const recentFeedback = feedback.slice(0, 8);
  const olderFeedback = feedback.slice(8, 16);

  const recentCycle = averageCycleMinutes(recentDone);
  const olderCycle = averageCycleMinutes(olderDone);
  const recentRating =
    recentFeedback.length > 0
      ? recentFeedback.reduce((sum, item) => sum + item.rating, 0) /
        recentFeedback.length
      : null;
  const olderRating =
    olderFeedback.length > 0
      ? olderFeedback.reduce((sum, item) => sum + item.rating, 0) /
        olderFeedback.length
      : null;

  const cycleImproved =
    recentCycle !== null &&
    olderCycle !== null &&
    recentCycle < olderCycle * 0.9;
  const cycleRegressed =
    recentCycle !== null &&
    olderCycle !== null &&
    recentCycle > olderCycle * 1.1;

  const ratingImproved =
    recentRating !== null &&
    olderRating !== null &&
    recentRating - olderRating >= 0.3;
  const ratingRegressed =
    recentRating !== null &&
    olderRating !== null &&
    olderRating - recentRating >= 0.3;

  if (cycleImproved || ratingImproved) return "improving";
  if (cycleRegressed || ratingRegressed) return "needs_attention";
  return "steady";
}

function averageCycleMinutes(tasks: Task[]): number | null {
  const values = tasks
    .map((task) => {
      const created = toMs(task.created_at);
      const updated = toMs(task.updated_at);
      if (created === null || updated === null) return null;
      if (updated <= created) return null;
      return (updated - created) / (1000 * 60);
    })
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildStrengths({
  avgFeedbackRating,
  approvalRate,
  reworkRate,
  avgCycleMinutes,
  agent,
}: {
  avgFeedbackRating: number | null;
  approvalRate: number;
  reworkRate: number;
  avgCycleMinutes: number;
  agent: SpecializedAgent;
}): string[] {
  const strengths: string[] = [];
  if (avgFeedbackRating !== null && avgFeedbackRating >= 4.4) {
    strengths.push("Consistently high user-rated output quality");
  }
  if (approvalRate >= 0.7) {
    strengths.push("Strong first-pass approval performance");
  }
  if (reworkRate <= 0.15) {
    strengths.push("Low rework rate across assigned tasks");
  }
  if (avgCycleMinutes <= 150) {
    strengths.push("Fast turnaround while maintaining quality");
  }
  if (strengths.length < 3) {
    strengths.push(...agent.capabilities.slice(0, 3 - strengths.length));
  }
  return strengths.slice(0, 3);
}

function buildImprovementFocus({
  avgFeedbackRating,
  approvalRate,
  reworkRate,
  avgCycleMinutes,
}: {
  avgFeedbackRating: number | null;
  approvalRate: number;
  reworkRate: number;
  avgCycleMinutes: number;
}): string {
  if (reworkRate > 0.25) {
    return "Reduce rework by validating requirements, assumptions, and edge-cases before final delivery.";
  }
  if (approvalRate < 0.55) {
    return "Increase first-pass acceptance by tightening output structure and decision rationale.";
  }
  if (avgFeedbackRating !== null && avgFeedbackRating < 3.8) {
    return "Improve depth and actionability: include clearer next steps, risk notes, and verification checks.";
  }
  if (avgCycleMinutes > 300) {
    return "Improve cycle time by splitting work into staged milestones and publishing progress checkpoints.";
  }
  return "Maintain quality with concise outputs, explicit assumptions, and repeatable checklists.";
}

function buildVocabulary(agent: SpecializedAgent): string[] {
  return [
    agent.name,
    agent.description,
    ...agent.capabilities,
    ...agent.suggestedTasks,
    agent.category || "",
  ]
    .join(" ")
    .toLowerCase()
    .split(/[\s,/.()]+/)
    .filter(Boolean);
}

function computeLexicalScore(
  tokens: string[],
  agent: SpecializedAgent
): { score: number; matchedTerms: string[] } {
  const vocabulary = new Set(buildVocabulary(agent));
  const matchedTerms = tokens.filter((token) => vocabulary.has(token));
  const scoreFromTokens = matchedTerms.length * 1.25;

  let phraseScore = 0;
  const lowerText = tokens.join(" ");
  for (const phrase of [...agent.capabilities, ...agent.suggestedTasks]) {
    if (phrase.length < 6) continue;
    const normalized = phrase.toLowerCase();
    if (lowerText.includes(normalized.slice(0, Math.min(18, normalized.length)))) {
      phraseScore += 1.5;
    }
  }

  return {
    score: scoreFromTokens + phraseScore,
    matchedTerms: Array.from(new Set(matchedTerms)).slice(0, 4),
  };
}

function buildReworkTaskIdsByAgent(
  allowedTaskIds?: Set<string>
): Map<string, Set<string>> {
  const byAgent = new Map<string, Set<string>>();
  const reworkEvents = listActivity({
    type: "task_rework",
    limit: 3000,
  }).filter((entry) => entry.agent_id && entry.task_id);

  for (const entry of reworkEvents) {
    if (!entry.agent_id || !entry.task_id) continue;
    if (allowedTaskIds && !allowedTaskIds.has(entry.task_id)) continue;
    if (!byAgent.has(entry.agent_id)) {
      byAgent.set(entry.agent_id, new Set<string>());
    }
    byAgent.get(entry.agent_id)!.add(entry.task_id);
  }

  return byAgent;
}

function createBuildContext(workspaceId?: string): IntelligenceBuildContext {
  const taskRows = workspaceId
    ? listTasks({ workspace_id: workspaceId })
    : listTasks({});
  const taskIdSet = new Set(taskRows.map((task) => task.id));

  const tasksByAgent = new Map<string, Task[]>();
  for (const task of taskRows) {
    if (!task.assigned_agent_id) continue;
    if (!tasksByAgent.has(task.assigned_agent_id)) {
      tasksByAgent.set(task.assigned_agent_id, []);
    }
    tasksByAgent.get(task.assigned_agent_id)!.push(task);
  }

  const feedbackByAgent = new Map<string, SpecialistFeedback[]>();
  for (const row of listSpecialistFeedback({ limit: 5000 })) {
    if (workspaceId && row.task_id && !taskIdSet.has(row.task_id)) {
      continue;
    }
    if (workspaceId && row.task_id === null) {
      continue;
    }
    if (!feedbackByAgent.has(row.specialist_id)) {
      feedbackByAgent.set(row.specialist_id, []);
    }
    feedbackByAgent.get(row.specialist_id)!.push(row);
  }

  return {
    tasksByAgent,
    feedbackByAgent,
    reworkTaskIdsByAgent: buildReworkTaskIdsByAgent(taskIdSet),
  };
}

export function buildSpecialistIntelligence(
  agent: SpecializedAgent,
  context?: IntelligenceBuildContext
): SpecialistIntelligenceSnapshot {
  const tasks =
    context?.tasksByAgent.get(agent.id) ||
    listTasks({ assigned_agent_id: agent.id });
  const feedback =
    context?.feedbackByAgent.get(agent.id) ||
    listSpecialistFeedback({
      specialist_id: agent.id,
      limit: 200,
    });
  const reworkTaskIds =
    context?.reworkTaskIdsByAgent.get(agent.id) || new Set<string>();

  const doneTasks = tasks.filter((task) => task.status === "done");
  const reviewTasks = tasks.filter((task) => task.status === "review");
  const activeTasks = tasks.filter(
    (task) => task.status === "in_progress" || task.status === "assigned"
  );

  const approvalRate =
    tasks.length > 0 ? doneTasks.length / tasks.length : 0;
  const reworkRate =
    tasks.length > 0 ? reworkTaskIds.size / tasks.length : 0;
  const avgCycleMinutesRaw = averageCycleMinutes(doneTasks) ?? 0;
  const avgFeedbackRatingRaw =
    feedback.length > 0
      ? feedback.reduce((sum, row) => sum + row.rating, 0) / feedback.length
      : null;

  const qualityScoreRaw =
    50 +
    Math.log10(doneTasks.length + 1) * 8 +
    approvalRate * 24 -
    reworkRate * 30 -
    clamp((avgCycleMinutesRaw - 120) / 24, 0, 12) +
    (avgFeedbackRatingRaw !== null ? (avgFeedbackRatingRaw - 3) * 10 : 0);
  const qualityScore = clamp(Math.round(qualityScoreRaw), 0, 100);

  const confidenceRaw =
    clamp((tasks.length / 24) * 0.65 + (feedback.length / 10) * 0.35, 0.05, 1);
  const confidence = round(confidenceRaw, 2);
  const trend = buildTrend(doneTasks, feedback);
  const avgFeedbackRating =
    avgFeedbackRatingRaw === null ? null : round(avgFeedbackRatingRaw, 2);
  const avgCycleMinutes = round(avgCycleMinutesRaw, 1);

  return {
    specialistId: agent.id,
    qualityScore,
    confidence,
    trend,
    approvalRate: round(approvalRate, 2),
    reworkRate: round(reworkRate, 2),
    avgCycleMinutes,
    avgFeedbackRating,
    feedbackCount: feedback.length,
    tasksAssigned: tasks.length,
    tasksDone: doneTasks.length,
    tasksInReview: reviewTasks.length,
    activeTasks: activeTasks.length,
    strengths: buildStrengths({
      avgFeedbackRating,
      approvalRate,
      reworkRate,
      avgCycleMinutes,
      agent,
    }),
    improvementFocus: buildImprovementFocus({
      avgFeedbackRating,
      approvalRate,
      reworkRate,
      avgCycleMinutes,
    }),
    generatedAt: new Date().toISOString(),
  };
}

export function buildAllSpecialistIntelligence(): Record<string, SpecialistIntelligenceSnapshot> {
  const context = createBuildContext();
  const byId: Record<string, SpecialistIntelligenceSnapshot> = {};
  for (const agent of getSpecializedAgents()) {
    byId[agent.id] = buildSpecialistIntelligence(agent, context);
  }
  return byId;
}

export function buildAllSpecialistIntelligenceByWorkspace(
  workspaceId: string
): Record<string, SpecialistIntelligenceSnapshot> {
  const context = createBuildContext(workspaceId);
  const byId: Record<string, SpecialistIntelligenceSnapshot> = {};
  for (const agent of getSpecializedAgents()) {
    byId[agent.id] = buildSpecialistIntelligence(agent, context);
  }
  return byId;
}

export function rankSpecialistsForTask(
  taskText: string,
  opts?: {
    limit?: number;
    busyAgentIds?: Set<string>;
    workspaceId?: string;
  }
): SpecialistRecommendation[] {
  const text = taskText.trim();
  const tokens = tokenize(text);
  const busy = opts?.busyAgentIds ?? new Set<string>();
  const specialists = getSpecializedAgents();
  const context = createBuildContext(opts?.workspaceId);

  const scored = specialists.map((agent) => {
    const intelligence = buildSpecialistIntelligence(agent, context);
    const lexical = computeLexicalScore(tokens, agent);
    const availabilityBonus = busy.has(agent.id) ? -0.4 : 0.4;
    const qualityMultiplier =
      0.75 +
      intelligence.qualityScore / 400 +
      intelligence.confidence / 3;

    const rawScore = (lexical.score + 0.5) * qualityMultiplier + availabilityBonus;
    const score = round(rawScore, 3);
    const confidence = round(
      clamp(
        0.3 +
          Math.min(0.5, lexical.score / 12) +
          intelligence.confidence * 0.2,
        0.1,
        0.95
      ),
      2
    );

    const reasons = [
      lexical.matchedTerms.length > 0
        ? `Matched terms: ${lexical.matchedTerms.join(", ")}`
        : "Matched through specialist domain profile",
      `Quality score ${intelligence.qualityScore}/100 (${intelligence.trend.replace("_", " ")})`,
      busy.has(agent.id)
        ? `${intelligence.activeTasks} active task${intelligence.activeTasks === 1 ? "" : "s"} in progress`
        : "Available for immediate assignment",
    ];

    return {
      agentId: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      color: agent.color,
      score,
      confidence,
      reasons,
      intelligence,
      available: !busy.has(agent.id),
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, opts?.limit ?? 3);
}

export function buildSpecialistExecutionContext(
  agentId: string,
  workspaceId?: string
): string {
  const specialist = getSpecializedAgents().find((agent) => agent.id === agentId);
  if (!specialist) return "";

  const snapshot = workspaceId
    ? buildSpecialistIntelligence(specialist, createBuildContext(workspaceId))
    : buildSpecialistIntelligence(specialist);
  const feedbackPart =
    snapshot.avgFeedbackRating !== null
      ? `${snapshot.avgFeedbackRating}/5 from ${snapshot.feedbackCount} ratings`
      : "not enough user feedback yet";
  const workspaceContext = workspaceId ? workspaceId : "global";

  return `## Adaptive Specialist Performance Context

You are operating with live quality intelligence:
- Quality score: ${snapshot.qualityScore}/100
- Trend: ${snapshot.trend.replace("_", " ")}
- Approval rate: ${Math.round(snapshot.approvalRate * 100)}%
- Rework rate: ${Math.round(snapshot.reworkRate * 100)}%
- Feedback: ${feedbackPart}
- Workspace scope: ${workspaceContext}
- Current improvement focus: ${snapshot.improvementFocus}

Strengths to preserve:
${snapshot.strengths.map((strength) => `- ${strength}`).join("\n")}

Execution rules for this task:
1. Be explicit about assumptions and decisions.
2. Provide actionable output with verification steps.
3. Prioritize accuracy and clarity over verbosity.
4. Add a concise self-check section before final answer.
`;
}
