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
export type TroposGoalType = "hardgoal" | "softgoal" | "task" | "resource";
export type BDIGoalType = "achieve" | "maintain" | "cease" | "avoid" | "query";
export type GoalType = TroposGoalType | BDIGoalType;

export type GoalState =
  | "pending"
  | "active"
  | "in_progress"
  | "achieved"
  | "failed"
  | "suspended"
  | "abandoned";

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
  category?: GoalBSCCategory; // BSC perspective
  domain?: GoalDomainCategory; // GOA domain perspective
  parentGoalId?: string; // explicit refinement parent
  goalState?: GoalState; // lifecycle state
  stateChangedAt?: string; // ISO timestamp of last state transition
  preconditions?: GoalPrecondition[];
};

export type GoalPrecondition = {
  id: string;
  name: string;
  type: "goal_state" | "condition" | "expression";
  expression: string;
  satisfied: boolean;
  referencedGoalId?: string;
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
  refinements?: GoalRefinement[]; // goal-to-goal edges
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
  mode?: "view" | "create";
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

// --- ERP: Inventory ---

export type StockItem = {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  reorder_point: number;
  warehouse_id: string | null;
  warehouse_name?: string;
  status: string;
  unit: string | null;
  created_at: string;
  updated_at: string;
};

export type StockMovement = {
  id: string;
  stock_item_id: string;
  type: "in" | "out" | "adjustment";
  quantity: number;
  reason: string | null;
  reference: string | null;
  created_at: string;
};

// --- ERP: Customers ---

export type Contact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  segment: string | null;
  lifecycle_stage: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

// --- ERP: Finance / Accounting ---

export type Invoice = {
  id: string;
  customer_id: string;
  customer_name?: string;
  status: string;
  amount: number;
  currency: string;
  due_date: string | null;
  line_items: Array<{ description: string; quantity: number; unit_price: number }>;
  created_at: string;
  updated_at: string;
};

export type Account = {
  id: string;
  name: string;
  type: string;
  currency: string;
  balance: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ProfitLoss = {
  from: string;
  to: string;
  net: number;
};

// --- ERP: E-Commerce ---

export type Product = {
  id: string;
  name: string;
  sku: string;
  price: number;
  currency: string;
  category: string | null;
  stock_qty: number;
  status: string;
  created_at: string;
  updated_at: string;
};

export type Order = {
  id: string;
  customer_id: string;
  customer_name?: string;
  status: string;
  total: number;
  currency: string;
  items: Array<{ product_id: string; quantity: number; unit_price: number }>;
  item_count?: number;
  created_at: string;
  updated_at: string;
};

// --- ERP: Suppliers ---

export type Supplier = {
  id: string;
  name: string;
  contact_email: string | null;
  category: string | null;
  rating: number | null;
  status: string;
  terms: string | null;
  created_at: string;
  updated_at: string;
};

export type PurchaseOrder = {
  id: string;
  supplier_id: string;
  status: string;
  total: number;
  currency: string;
  items: Array<{ description: string; quantity: number; unit_cost: number }>;
  expected_delivery: string | null;
  created_at: string;
  updated_at: string;
};

// --- ERP: Marketing ---

export type Campaign = {
  id: string;
  name: string;
  type: string;
  status: string;
  budget: number | null;
  start_date: string | null;
  end_date: string | null;
  target_audience: string | null;
  channels: string[] | null;
  created_at: string;
  updated_at: string;
};

export type CampaignMetric = {
  id: string;
  campaign_id: string;
  metric_type: string;
  value: number;
  recorded_at: string;
};

export type MarketingKpi = {
  id: string;
  name: string;
  target: number;
  current: number;
  unit: string | null;
  period: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

// --- ERP: Supply Chain ---

export type Shipment = {
  id: string;
  order_id: string | null;
  supplier_id: string | null;
  origin: string;
  destination: string;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
  estimated_arrival: string | null;
  created_at: string;
  updated_at: string;
};

export type Route = {
  id: string;
  name: string;
  origin: string;
  destination: string;
  legs: Array<{ from: string; to: string }> | null;
  status: string;
  created_at: string;
  updated_at: string;
};

// --- ERP: Compliance ---

export type CompliancePolicy = {
  id: string;
  title: string;
  category: string;
  version: string | null;
  status: string;
  effective_date: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
};

export type Violation = {
  id: string;
  policy_id: string | null;
  severity: string;
  status: string;
  description: string;
  reported_by: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
};

// --- ERP: Legal ---

export type PartnershipContract = {
  id: string;
  partner_name: string;
  partner_type: string | null;
  ownership_pct: number | null;
  revenue_share_pct: number | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  terms: string | null;
  document_url: string | null;
  created_at: string;
  updated_at: string;
};

export type FreelancerContract = {
  id: string;
  contractor_name: string;
  scope_of_work: string | null;
  rate_type: "hourly" | "fixed" | "retainer";
  rate_amount: number;
  currency: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  deliverables: unknown[] | null;
  document_url: string | null;
  created_at: string;
  updated_at: string;
};

export type CorporateDocument = {
  id: string;
  doc_type: string;
  title: string | null;
  filing_date: string | null;
  expiry_date: string | null;
  jurisdiction: string | null;
  status: string;
  document_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type LegalStructure = {
  id: string;
  business_name: string;
  legal_name: string | null;
  entity_type: string;
  state_of_formation: string | null;
  ein: string | null;
  formation_date: string | null;
  registered_agent: string | null;
  principal_address: string | null;
  created_at: string;
  updated_at: string;
};

export type ComplianceGuardrail = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  rule_expression: string | null;
  severity: "info" | "warning" | "critical";
  active: boolean;
  created_at: string;
  updated_at: string;
};

// --- ERP: Analytics ---

export type AnalyticsReport = {
  id: string;
  name: string;
  type: string;
  query: string;
  parameters: Record<string, unknown> | null;
  schedule: string | null;
  status: string;
  last_run: string | null;
  created_at: string;
  updated_at: string;
};

export type ReportSnapshot = {
  id: string;
  report_id: string;
  data: unknown;
  row_count: number | null;
  executed_at: string;
};

export type AnalyticsDashboard = {
  id: string;
  name: string;
  description: string | null;
  widgets: Array<{
    type: string;
    reportId: string;
    position: { x: number; y: number; w: number; h: number };
  }> | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
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
