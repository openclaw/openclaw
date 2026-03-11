export type AgentStatus = "active" | "idle" | "error" | "paused";

export type Agent = {
  id: string;
  name: string;
  role: string;
  department: string;
  status: AgentStatus;
  description?: string;
  currentTask?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  agentId?: string;
  agentName?: string;
  content: string;
  timestamp: Date;
  streaming?: boolean;
  actions?: ChatAction[];
};

export type Business = {
  id: string;
  name: string;
  description: string;
  stage: string;
  agentCount: number;
  healthScore: number;
};

export type Task = {
  id: string;
  plan_id: string;
  plan_name: string;
  step_id: string;
  title: string;
  description?: string;
  status: "backlog" | "todo" | "in_progress" | "review" | "done";
  priority: "low" | "medium" | "high";
  type: string;
  assignedAgents: string[];
  department: string;
  depends_on: string[];
  estimated_duration: string;
  agent_id: string;
};

export type ProjectSLA = "critical" | "standard" | "relaxed";

export type Project = {
  id: string;
  name: string;
  sla: ProjectSLA;
  taskCount: number;
  completedCount: number;
};

export type SystemStatus = {
  product: string;
  version: string;
  bdiHeartbeat: string;
  bdiIntervalMinutes: number;
  agents: Array<{
    agentId: string;
    beliefCount: number;
    goalCount: number;
    intentionCount: number;
    desireCount: number;
  }>;
  businessCount: number;
  workspaceDir: string;
  reasoningToolCount: number;
};

export type AgentListItem = {
  id: string;
  name: string;
  type: "core" | "domain";
  beliefs: number;
  goals: number;
  intentions: number;
  desires: number;
  status: AgentStatus;
  autonomy_level: "low" | "medium" | "high";
  approval_threshold_usd: number;
};

export type AgentListResponse = {
  agents: AgentListItem[];
};

export type AgentDetail = {
  agentId: string;
  beliefCount: number;
  goalCount: number;
  intentionCount: number;
  desireCount: number;
  beliefs: string[];
  goals: string[];
  intentions: string[];
  desires: string[];
};

// --- Decisions ---

export type DecisionUrgency = "critical" | "high" | "medium" | "low";

export type DecisionOption = {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
};

export type Decision = {
  id: string;
  title: string;
  summary: string;
  urgency: DecisionUrgency;
  agentId: string;
  agentName: string;
  businessId: string;
  businessName: string;
  options: DecisionOption[];
  agentRecommendation?: string;
  createdAt: string;
};

export type DecisionsResponse = { decisions: Decision[] };

export type DecisionResolution = {
  optionId: string;
  feedback?: string;
  action: "approve" | "reject" | "defer";
};

// --- Goals / Workflows ---

export type GoalLevel = "strategic" | "tactical" | "operational";
export type GoalType = "hardgoal" | "softgoal" | "task" | "resource";

export type GoalPerspective = "level" | "actor" | "type" | "bsc" | "goa-domain";

// Balanced Scorecard perspectives
export type GoalBSCCategory = "financial" | "customer" | "internal-process" | "learning-growth";

// GOA Domain perspectives (from Goal-Oriented Architecture)
export type GoalDomainCategory = "safety" | "efficiency" | "responsiveness" | "robustness";

// Goal refinement relationship (goal-to-goal edges)
export type GoalRefinement = {
  parentGoalId: string;
  childGoalId: string;
  type: "and-refinement" | "or-refinement" | "contribution";
  label?: string;
  inferred?: boolean; // true if AI/hierarchy-inferred, false if explicit
};
export type WorkflowStatus = "active" | "completed" | "paused" | "pending";

export type WorkflowStep = {
  id: string;
  name: string;
  order: number;
  schedule?: CronScheduleInfo;
  action?: string; // tool name mapped to this step
};

export type Workflow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  agents: string[];
  steps: WorkflowStep[];
  schedule?: CronScheduleInfo;
  workflowType?: string;
  trigger?: string;
};

export type BusinessGoal = {
  id: string;
  name: string;
  text?: string;
  description: string;
  level: GoalLevel;
  type: GoalType;
  priority: number;
  actor?: string;
  desires: string[];
  workflows: Workflow[];
  category?: GoalBSCCategory;      // BSC perspective
  domain?: GoalDomainCategory;      // GOA domain perspective
  parentGoalId?: string;            // explicit refinement parent
};

export type TroposActor = {
  id: string;
  name: string;
  type: "principal" | "agent";
  goals: string[];
};

export type TroposDependency = {
  from: string;
  to: string;
  type: "delegation" | "contribution";
  goalId: string;
};

export type TroposGoalModel = {
  actors: TroposActor[];
  goals: BusinessGoal[];
  dependencies: TroposDependency[];
  refinements?: GoalRefinement[];   // goal-to-goal edges
};

// --- Contractors ---

export type Contractor = {
  id: string;
  name: string;
  role: string;
  trustScore: number;
  packages: number;
  status: "active" | "inactive" | "pending";
};

export type ContractorsResponse = { contractors: Contractor[] };

// --- Panel / Layout ---

export type SidebarMode = "collapsed" | "expanded";

export type EntityType =
  | "decision"
  | "goal"
  | "project"
  | "task"
  | "agent"
  | "workflow"
  | "bpmn-node"
  | "knowledge-graph-node"
  | "timeline-event";

export type DetailPanelState = {
  open: boolean;
  entityType: EntityType | null;
  entityId: string | null;
  entityData: unknown;
};

// --- Cron / Scheduling ---

export type CronJobStatus = "active" | "paused" | "error";

export type CronScheduleInfo = {
  cronExpression: string; // "0 9 * * MON"
  cronJobId?: string; // link to CronJob.id in cron-jobs.json
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  timezone?: string;
};

export type CronJob = {
  id: string;
  name: string;
  schedule: string; // cron expression
  agentId: string;
  action: string; // tool name or workflow ID to execute
  enabled: boolean;
  lastRun?: string; // ISO timestamp
  nextRun?: string; // ISO timestamp
  status: CronJobStatus;
  workflowId?: string; // links to Workflow.id
  stepId?: string; // links to WorkflowStep.id
  parentCronId?: string; // ID in parent OpenClaw cron store
};

export type CronJobsResponse = { jobs: CronJob[] };

// --- Kanban / SLA Perspectives ---

export type KanbanColumnConfig = {
  id: string;
  title: string;
  color: string;
  statuses: Task["status"][];
};

export type SLAPerspective = {
  id: string;
  label: string;
  description: string;
  columns: KanbanColumnConfig[];
};

// --- Agent Files ---

export type AgentFileInfo = {
  filename: string;
  category: "bdi" | "core";
  size: number;
  modified: string;
};

export type AgentFileContent = {
  filename: string;
  content: string;
  category: "bdi" | "core";
};

// --- Chat Actions ---

export type ChatActionType = "invalidate_query" | "mutate_data" | "navigate" | "open_detail";

export type ChatAction = {
  type: ChatActionType;
  payload: {
    queryKeys?: string[][];
    mutationFn?: string;
    mutationData?: Record<string, unknown>;
    route?: string;
    entityType?: EntityType;
    entityId?: string;
    entityData?: unknown;
  };
};
