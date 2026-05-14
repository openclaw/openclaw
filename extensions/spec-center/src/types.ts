export const SPEC_ARTIFACT_NAMES = [
  "overview.md",
  "requirements.md",
  "design.md",
  "tasks.md",
  "coverage.md",
  "runbook.md",
] as const;

export type SpecArtifactName = (typeof SPEC_ARTIFACT_NAMES)[number];

export type SpecLifecycleStatus =
  | "draft"
  | "review"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "archived";

export type SpecSource = {
  kind: "git" | "local";
  repo: string;
  ref?: string;
  path: string;
  commit?: string;
};

export type SpecOwner = {
  team?: string;
  maintainer?: string;
};

export type SpecArtifact = {
  name: SpecArtifactName;
  path: string;
  title?: string;
  summary?: string;
  generated: boolean;
};

export type SpecStepType = "agent_task" | "tool_task" | "approval" | "validation" | "notify";

export type SpecStep = {
  id: string;
  type: SpecStepType;
  title: string;
  dependsOn: string[];
  condition?: string;
  outputs: string[];
  task?: string;
  tool?: string;
};

export type SpecImportWarning = {
  code: string;
  message: string;
};

export type SpecRecord = {
  id: string;
  title: string;
  type: string;
  status: SpecLifecycleStatus;
  version: number;
  owner?: SpecOwner;
  targetRepo?: string;
  source: SpecSource;
  artifacts: SpecArtifact[];
  artifactDir: string;
  steps: SpecStep[];
  warnings: SpecImportWarning[];
  importedAt: string;
  updatedAt: string;
};

export type SpecCheckIssueSeverity = "error" | "warning";

export type SpecCheckIssue = {
  severity: SpecCheckIssueSeverity;
  code: string;
  message: string;
};

export type SpecCheckResult = {
  ok: boolean;
  issues: SpecCheckIssue[];
};

export type SpecPreviewWave = {
  wave: number;
  steps: string[];
};

export type SpecRunPreview = {
  specId: string;
  title: string;
  stepCount: number;
  waves: SpecPreviewWave[];
  approvalSteps: string[];
  validationSteps: string[];
  issues: SpecCheckIssue[];
};

export type SpecRunStatus = "previewed" | "queued" | "running" | "succeeded" | "failed" | "blocked";

export type SpecRunRecord = {
  runId: string;
  specId: string;
  status: SpecRunStatus;
  createdAt: string;
  flowId?: string;
  preview: SpecRunPreview;
};

export type SpecScheduleRecord = {
  specId: string;
  cron: string;
  timezone: string;
  reportTo: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
};

export type SpecOptimizationStatus = "previewed" | "approved" | "rejected" | "changes_requested";

export type SpecOptimizationRecord = {
  optimizationId: string;
  specId: string;
  instruction: string;
  status: SpecOptimizationStatus;
  createdAt: string;
  sourceRunId?: string;
  proposedFiles: SpecArtifactName[];
  proposedChanges: string[];
  risk: string;
  dryRun: "passed" | "blocked";
  dryRunReason: string;
};

export type SpecApprovalRecord = {
  approvalId: string;
  specId: string;
  targetType: "spec_optimization";
  targetId: string;
  decision: SpecOptimizationStatus;
  createdAt: string;
  actor?: string;
  note?: string;
};

export type SpecCenterState = {
  version: 1;
  team?: string;
  owner?: string;
  approvers: string[];
  specs: Record<string, SpecRecord>;
  runs: SpecRunRecord[];
  schedules: Record<string, SpecScheduleRecord>;
  optimizations: SpecOptimizationRecord[];
  approvals: SpecApprovalRecord[];
};

export type ImportSpecInput = {
  id?: string;
  repo?: string;
  ref?: string;
  path?: string;
  targetRepo?: string;
};

export type SpecImportResult = {
  spec: SpecRecord;
  check: SpecCheckResult;
  preview: SpecRunPreview;
};
