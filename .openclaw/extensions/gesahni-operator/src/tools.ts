import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createGesahniOperatorClient, type BridgeAuthMode, type BridgeMethod } from "./client.js";
import { resolveGesahniOperatorConfig } from "./config.js";

type ToolSpec = {
  name: GesahniOperatorToolName;
  description: string;
  method: BridgeMethod;
  auth: BridgeAuthMode;
  pathTemplate: string;
  parameters: Record<string, unknown>;
  requiredKeys: readonly string[];
};

type ToolArgs = Record<string, unknown>;

const UserIdSchema = {
  type: "string",
  minLength: 1,
  description:
    "Bridge tenant identifier. For Telegram direct messages, use tg:<chat_id>. telegram:<chat_id> and bare numeric ids are accepted and normalized to tg:<chat_id> before HTTP.",
} as const;
const ProjectIdSchema = { type: "string", minLength: 1 } as const;
const RunIdSchema = { type: "string", minLength: 1 } as const;
const ApprovalIdSchema = { type: "string", minLength: 1 } as const;
const IdempotencyKeySchema = { type: "string", minLength: 1 } as const;
const NonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const VersionSchema = { type: "integer" } as const;
const JsonObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;
const IntakePayloadSchema = {
  ...JsonObjectSchema,
  description: "Required update_intake_from_context body. Use {} when no extra flags are needed.",
} as const;
const WorkflowBodySchema = {
  ...JsonObjectSchema,
  description:
    "Optional initialize_website_workflow body. Use {} when no extra options are needed.",
} as const;
const PreviewRequestSchema = {
  ...JsonObjectSchema,
  description: "Optional request_preview_deploy body. Use {} when no extra options are needed.",
} as const;
const WorkflowSnapshotSchema = {
  ...JsonObjectSchema,
  description:
    "Required structured workflow snapshot object. Pass the real details object returned by get_website_workflow_snapshot.",
} as const;

const UserOnlyParameters = {
  user_id: UserIdSchema,
};

const ProjectParameters = {
  user_id: UserIdSchema,
  project_id: ProjectIdSchema,
};

const ProjectRunParameters = {
  user_id: UserIdSchema,
  project_id: ProjectIdSchema,
  run_id: RunIdSchema,
};

const ProjectApprovalParameters = {
  user_id: UserIdSchema,
  project_id: ProjectIdSchema,
  approval_id: ApprovalIdSchema,
};

export const GESAHNI_OPERATOR_TOOL_NAMES = [
  "get_project_snapshot",
  "list_projects",
  "get_intake_snapshot",
  "get_website_workflow_snapshot",
  "get_website_orchestration_plan",
  "get_project_operator_summary",
  "get_run_report",
  "get_rerun_presentation",
  "get_preview_deploy_snapshot",
  "create_project",
  "attach_project_context",
  "update_intake_from_context",
  "initialize_website_workflow",
  "request_preview_deploy",
  "approve_approval",
  "reject_approval",
  "cancel_approval",
] as const;

export type GesahniOperatorToolName = (typeof GESAHNI_OPERATOR_TOOL_NAMES)[number];

type WebsiteWorkflowStage = "research" | "sitemap" | "copy" | "build" | "review";

const WEBSITE_STAGE_PLAN: Record<
  WebsiteWorkflowStage,
  { agent_id: string; artifact_type: string }
> = {
  research: { agent_id: "gesahni-researcher", artifact_type: "research_summary" },
  sitemap: { agent_id: "gesahni-builder", artifact_type: "sitemap" },
  copy: { agent_id: "gesahni-builder", artifact_type: "copy_draft" },
  build: { agent_id: "gesahni-builder", artifact_type: "code_draft" },
  review: { agent_id: "gesahni-reviewer", artifact_type: "review_notes" },
};

const FINAL_RESULT_FIELDS = [
  "project_id",
  "research_task_id",
  "sitemap_task_id",
  "copy_task_id",
  "build_task_id",
  "review_task_id",
  "research_artifact_id",
  "sitemap_artifact_id",
  "copy_artifact_id",
  "code_artifact_id",
  "review_artifact_id",
  "current_stage",
  "next_stage",
  "blockers",
  "preview_state",
  "preview_latest_result",
  "final_status",
] as const;

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "get_project_snapshot",
    description: "Fetch a project snapshot from the Gesahni Operator bridge.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "list_projects",
    description: "List Gesahni Operator projects for a specific bridge user.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects",
    parameters: UserOnlyParameters,
    requiredKeys: ["user_id"],
  },
  {
    name: "get_intake_snapshot",
    description: "Fetch the intake snapshot for a Gesahni Operator project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/intake/snapshot",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_website_workflow_snapshot",
    description: "Fetch the website workflow snapshot for a Gesahni Operator project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/website/workflow/snapshot",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_project_operator_summary",
    description: "Fetch the operator summary for a Gesahni Operator project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/operator/summary",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_run_report",
    description: "Fetch a project run report from the Gesahni Operator bridge.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/runs/{run_id}/report",
    parameters: ProjectRunParameters,
    requiredKeys: ["user_id", "project_id", "run_id"],
  },
  {
    name: "get_rerun_presentation",
    description: "Fetch the rerun presentation payload for a Gesahni Operator project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/rerun-presentation",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_preview_deploy_snapshot",
    description: "Fetch the preview deploy snapshot for a Gesahni Operator project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/preview-deploy/snapshot",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "create_project",
    description: "Create a Gesahni Operator project through the bridge.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects",
    parameters: {
      user_id: UserIdSchema,
      title: {
        ...NonEmptyStringSchema,
        description: "Required base project title. Use only the base row field here.",
      },
      client_name: {
        ...NonEmptyStringSchema,
        description: "Required client name for the base project row only.",
      },
      project_type: {
        ...NonEmptyStringSchema,
        description: "Required base project type for create_project.",
      },
      goal: {
        ...NonEmptyStringSchema,
        description: "Required base project goal. Do not place full brief context here.",
      },
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "title", "client_name", "project_type", "goal"],
  },
  {
    name: "attach_project_context",
    description: "Attach context to a Gesahni Operator project through the bridge.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/context",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      context_type: {
        ...NonEmptyStringSchema,
        description: "Required wrapped context type for attach_project_context.",
      },
      source: {
        ...NonEmptyStringSchema,
        description: "Required source identifier for the wrapped project context.",
      },
      content_json: {
        ...JsonObjectSchema,
        description:
          "Required wrapped context payload object. Put the rich brief in content_json instead of top-level fields.",
      },
      content_text: {
        ...NonEmptyStringSchema,
        description: "Optional human-readable context text.",
      },
      version: {
        ...VersionSchema,
        description: "Optional context version number.",
      },
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "context_type", "source", "content_json"],
  },
  {
    name: "update_intake_from_context",
    description: "Update project intake from attached context through the bridge.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/intake/update-from-context",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      payload: IntakePayloadSchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "payload"],
  },
  {
    name: "initialize_website_workflow",
    description: "Initialize website workflow state for a Gesahni Operator project.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/website/workflow/initialize",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      workflow: WorkflowBodySchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "request_preview_deploy",
    description: "Request a preview deploy for a Gesahni Operator project.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/preview-deploy/request",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      request: PreviewRequestSchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "approve_approval",
    description: "Approve a Gesahni Operator approval through the bridge.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/approvals/{approval_id}/approve",
    parameters: {
      ...ProjectApprovalParameters,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "approval_id"],
  },
  {
    name: "reject_approval",
    description: "Reject a Gesahni Operator approval through the bridge.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/approvals/{approval_id}/reject",
    parameters: {
      ...ProjectApprovalParameters,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "approval_id"],
  },
  {
    name: "cancel_approval",
    description: "Cancel a Gesahni Operator approval through the bridge.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/approvals/{approval_id}/cancel",
    parameters: {
      ...ProjectApprovalParameters,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "approval_id"],
  },
] as const;

function readRequiredString(params: ToolArgs, key: string): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new Error(`${key} required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${key} required`);
  }
  return trimmed;
}

function readOptionalString(params: ToolArgs, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function validateRequiredKeys(params: ToolArgs, spec: ToolSpec) {
  for (const key of spec.requiredKeys) {
    const value = params[key];
    if (typeof value === "string") {
      if (!value.trim()) {
        throw new Error(`${key} required`);
      }
      continue;
    }
    if (value && typeof value === "object") {
      continue;
    }
    throw new Error(`${key} required`);
  }
}

function validateAllowedKeys(params: ToolArgs, spec: ToolSpec) {
  const allowedKeys = new Set(Object.keys(spec.parameters));
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${key} not allowed`);
    }
  }
}

function readRequiredObject(params: ToolArgs, key: string): Record<string, unknown> {
  const value = params[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} required`);
  }
  return value as Record<string, unknown>;
}

function buildCreateProjectBody(params: ToolArgs) {
  return {
    title: readRequiredString(params, "title"),
    client_name: readRequiredString(params, "client_name"),
    project_type: readRequiredString(params, "project_type"),
    goal: readRequiredString(params, "goal"),
  };
}

function buildAttachProjectContextBody(params: ToolArgs) {
  const body: Record<string, unknown> = {
    context_type: readRequiredString(params, "context_type"),
    source: readRequiredString(params, "source"),
    content_json: readRequiredObject(params, "content_json"),
  };

  const contentText = readOptionalString(params, "content_text");
  if (contentText) {
    body.content_text = contentText;
  }

  const version = params.version;
  if (version !== undefined) {
    if (!Number.isInteger(version)) {
      throw new Error("version must be an integer");
    }
    body.version = version;
  }

  return body;
}

function buildRequestBody(spec: ToolSpec, params: ToolArgs): unknown {
  if (spec.name === "create_project") {
    return buildCreateProjectBody(params);
  }
  if (spec.name === "attach_project_context") {
    return buildAttachProjectContextBody(params);
  }
  if (spec.name === "update_intake_from_context") {
    return { payload: readRequiredObject(params, "payload") };
  }
  if (spec.name === "initialize_website_workflow") {
    return params.workflow === undefined ? undefined : readRequiredObject(params, "workflow");
  }
  if (spec.name === "request_preview_deploy") {
    return params.request === undefined ? undefined : readRequiredObject(params, "request");
  }
  return undefined;
}

function normalizeBridgeUserId(raw: string): string {
  const trimmed = raw.trim();
  const telegramMatch = /^telegram:(-?\d+)$/i.exec(trimmed);
  if (telegramMatch?.[1]) {
    return `tg:${telegramMatch[1]}`;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return `tg:${trimmed}`;
  }
  return trimmed;
}

function buildPath(pathTemplate: string, params: ToolArgs): string {
  let path = pathTemplate;
  if (path.includes("{project_id}")) {
    path = path.replaceAll(
      "{project_id}",
      encodeURIComponent(readRequiredString(params, "project_id")),
    );
  }
  if (path.includes("{run_id}")) {
    path = path.replaceAll("{run_id}", encodeURIComponent(readRequiredString(params, "run_id")));
  }
  if (path.includes("{approval_id}")) {
    path = path.replaceAll(
      "{approval_id}",
      encodeURIComponent(readRequiredString(params, "approval_id")),
    );
  }
  return path;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function normalizeWorkflowStage(value: unknown): WebsiteWorkflowStage | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "research" ||
    trimmed === "sitemap" ||
    trimmed === "copy" ||
    trimmed === "build" ||
    trimmed === "review"
  ) {
    return trimmed;
  }
  return null;
}

function readOptionalObject(params: ToolArgs, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function findStageStatus(
  workflow: Record<string, unknown>,
  stage: WebsiteWorkflowStage,
): string | null {
  const stages = workflow.stages;
  if (!Array.isArray(stages)) {
    return null;
  }
  for (const candidate of stages) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (normalizeWorkflowStage(record.stage) === stage && typeof record.status === "string") {
      return record.status.trim().toLowerCase();
    }
  }
  return null;
}

function buildWebsiteOrchestrationPlan(params: ToolArgs) {
  const projectId = readRequiredString(params, "project_id");
  const rawWorkflowSnapshot = readRequiredObject(params, "workflow_snapshot");
  const workflowCandidate = rawWorkflowSnapshot.workflow;
  const workflow =
    workflowCandidate && typeof workflowCandidate === "object" && !Array.isArray(workflowCandidate)
      ? (workflowCandidate as Record<string, unknown>)
      : rawWorkflowSnapshot;

  const currentStage = normalizeWorkflowStage(workflow.current_stage);
  if (!currentStage) {
    throw new Error(
      "workflow_snapshot.current_stage must be research, sitemap, copy, build, or review",
    );
  }

  const nextStage = normalizeWorkflowStage(workflow.next_stage) ?? currentStage;
  const workflowInitialized = workflow.workflow_initialized !== false;
  const blockers = Array.isArray(workflow.blockers) ? workflow.blockers : [];
  const currentStageStatus = findStageStatus(workflow, currentStage);
  const stagePlan = WEBSITE_STAGE_PLAN[currentStage];
  const previewSnapshot = readOptionalObject(params, "preview_snapshot");
  const previewState = typeof previewSnapshot?.state === "string" ? previewSnapshot.state : null;
  const previewLatestResult = Object.prototype.hasOwnProperty.call(
    previewSnapshot ?? {},
    "latest_result",
  )
    ? (previewSnapshot?.latest_result ?? null)
    : null;
  const stageBlocked =
    currentStageStatus === "blocked" ||
    (!workflowInitialized && currentStage !== "research") ||
    (blockers.length > 0 && currentStageStatus !== "ready" && currentStageStatus !== "created");

  const plan = stageBlocked
    ? {
        action: "stop_blocked",
        delegate_agent_id: null,
        delegate_stage: currentStage,
        expected_artifact_type: stagePlan.artifact_type,
        reason:
          "Current workflow stage is blocked and needs human-visible truth, not speculative writes.",
      }
    : {
        action: "delegate_specialist",
        delegate_agent_id: stagePlan.agent_id,
        delegate_stage: currentStage,
        expected_artifact_type: stagePlan.artifact_type,
        reason: "Current workflow stage is ready for specialist execution.",
      };

  return {
    project_id: projectId,
    workflow_initialized: workflowInitialized,
    current_stage: currentStage,
    current_stage_status: currentStageStatus,
    next_stage: nextStage,
    blockers,
    preview_state: previewState,
    preview_latest_result: previewLatestResult,
    plan,
    operator_allowed_tools: [
      "create_project",
      "attach_project_context",
      "update_intake_from_context",
      "get_intake_snapshot",
      "initialize_website_workflow",
      "get_website_workflow_snapshot",
      "get_website_orchestration_plan",
      "get_project_operator_summary",
      "get_preview_deploy_snapshot",
      "sessions_send",
    ],
    preferred_delegation_tool: "sessions_send",
    operator_must_not_auto_invoke: [
      "create_artifact",
      "attach_task_outputs",
      "update_task_status",
      "append_project_event",
      "request_preview_deploy",
      "approve_approval",
      "reject_approval",
      "cancel_approval",
    ],
    required_follow_up_reads: [
      "get_website_workflow_snapshot",
      "get_project_operator_summary",
      "get_preview_deploy_snapshot",
    ],
    final_result_fields: [...FINAL_RESULT_FIELDS],
  };
}

function buildBridgeResult(
  payload: Awaited<ReturnType<ReturnType<typeof createGesahniOperatorClient>["request"]>>,
) {
  if (payload.ok) {
    return jsonResult(payload.body);
  }

  return jsonResult({
    ok: false,
    status: payload.status,
    statusText: payload.statusText,
    error: payload.body,
  });
}

export function createGesahniOperatorTools(
  api: Pick<OpenClawPluginApi, "pluginConfig">,
  options?: { fetchImpl?: typeof fetch },
): AnyAgentTool[] {
  const client = createGesahniOperatorClient({
    config: resolveGesahniOperatorConfig(api),
    fetchImpl: options?.fetchImpl,
  });

  const bridgeTools = TOOL_SPECS.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: {
      type: "object",
      properties: spec.parameters,
      required: [...spec.requiredKeys],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = (rawParams ?? {}) as ToolArgs;
      validateAllowedKeys(params, spec);
      validateRequiredKeys(params, spec);
      const userId = normalizeBridgeUserId(readRequiredString(params, "user_id"));
      const idempotencyKey = readOptionalString(params, "idempotency_key");
      return buildBridgeResult(
        await client.request({
          path: buildPath(spec.pathTemplate, params),
          method: spec.method,
          auth: spec.auth,
          userId,
          body: buildRequestBody(spec, params),
          idempotencyKey,
        }),
      );
    },
  }));

  const orchestrationPlanTool: AnyAgentTool = {
    name: "get_website_orchestration_plan",
    label: "get_website_orchestration_plan",
    description:
      "Turn a real website workflow snapshot into the next specialist delegation lane without giving operator specialist write powers.",
    parameters: {
      type: "object",
      properties: {
        project_id: ProjectIdSchema,
        workflow_snapshot: WorkflowSnapshotSchema,
        preview_snapshot: {
          ...JsonObjectSchema,
          description:
            "Optional structured preview snapshot object from get_preview_deploy_snapshot for honest final-state rereads.",
        },
      },
      required: ["project_id", "workflow_snapshot"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = (rawParams ?? {}) as ToolArgs;
      return jsonResult(buildWebsiteOrchestrationPlan(params));
    },
  };

  const orchestrationIndex = GESAHNI_OPERATOR_TOOL_NAMES.indexOf("get_website_orchestration_plan");
  return [
    ...bridgeTools.slice(0, orchestrationIndex),
    orchestrationPlanTool,
    ...bridgeTools.slice(orchestrationIndex),
  ];
}
