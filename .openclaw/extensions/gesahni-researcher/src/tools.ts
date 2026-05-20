import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createGesahniResearcherClient, type BridgeAuthMode, type BridgeMethod } from "./client.js";
import { resolveGesahniResearcherConfig } from "./config.js";

type ToolSpec = {
  name: GesahniResearcherToolName;
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
const TaskIdSchema = { type: "string", minLength: 1 } as const;
const RunIdSchema = { type: "string", minLength: 1 } as const;
const IdempotencyKeySchema = { type: "string", minLength: 1 } as const;
const JsonObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;
const ResearchArtifactSchema = {
  ...JsonObjectSchema,
  description:
    "Bridge artifact create payload. Must represent a research_summary artifact and include a summary plus optional structured preview payload.",
} as const;
const TaskOutputsSchema = {
  ...JsonObjectSchema,
  description:
    "Bridge task outputs payload object for POST /tasks/{task_id}/outputs. Include output_artifact_ids or legacy outputs and this tool will normalize to the bridge shape.",
} as const;
const TaskStatusSchema = {
  ...JsonObjectSchema,
  description:
    "Bridge task status payload object for PATCH /tasks/{task_id}/status. Include status transitions only for the assigned research task.",
} as const;
const ProjectEventSchema = {
  ...JsonObjectSchema,
  description:
    "Bridge project event payload object. Include event/event_type plus research-stage details; this tool maps legacy fields to the bridge schema.",
} as const;

const ProjectParameters = {
  user_id: UserIdSchema,
  project_id: ProjectIdSchema,
};

export const GESAHNI_RESEARCHER_TOOL_NAMES = [
  "get_project_snapshot",
  "get_intake_snapshot",
  "get_website_workflow_snapshot",
  "get_project_operator_summary",
  "create_artifact",
  "attach_task_outputs",
  "update_task_status",
  "append_project_event",
] as const;

export type GesahniResearcherToolName = (typeof GESAHNI_RESEARCHER_TOOL_NAMES)[number];

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "get_project_snapshot",
    description: "Fetch a project snapshot from the Gesahni bridge.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_intake_snapshot",
    description: "Fetch the intake snapshot for a Gesahni project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/intake/snapshot",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_website_workflow_snapshot",
    description: "Fetch the website workflow snapshot for a Gesahni project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/website/workflow/snapshot",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "get_project_operator_summary",
    description: "Fetch the operator summary for a Gesahni project.",
    method: "GET",
    auth: "read",
    pathTemplate: "/v1/bridge/projects/{project_id}/operator/summary",
    parameters: ProjectParameters,
    requiredKeys: ["user_id", "project_id"],
  },
  {
    name: "create_artifact",
    description:
      "Create a research_summary artifact for the current project. Artifact payload must be a research artifact shape.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/artifacts",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      task_id: TaskIdSchema,
      artifact: ResearchArtifactSchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "task_id", "artifact"],
  },
  {
    name: "attach_task_outputs",
    description:
      "Attach outputs to the assigned research task only. Keep payload narrow and include the created artifact id.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/tasks/{task_id}/outputs",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      task_id: TaskIdSchema,
      outputs: TaskOutputsSchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "task_id", "outputs"],
  },
  {
    name: "update_task_status",
    description: "Update status only for the assigned research task.",
    method: "PATCH",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/tasks/{task_id}/status",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      task_id: TaskIdSchema,
      status: TaskStatusSchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "task_id", "status"],
  },
  {
    name: "append_project_event",
    description: "Append a project event tied to the research completion flow.",
    method: "POST",
    auth: "write",
    pathTemplate: "/v1/bridge/projects/{project_id}/runs/{run_id}/events",
    parameters: {
      user_id: UserIdSchema,
      project_id: ProjectIdSchema,
      event: ProjectEventSchema,
      run_id: RunIdSchema,
      idempotency_key: {
        ...IdempotencyKeySchema,
      },
    },
    requiredKeys: ["user_id", "project_id", "event"],
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

function buildCreateArtifactBody(params: ToolArgs) {
  const projectId = readRequiredString(params, "project_id");
  const taskId = readRequiredString(params, "task_id");
  const artifact = readRequiredObject(params, "artifact");
  const artifactType = artifact.artifact_type;
  if (artifactType !== undefined) {
    if (typeof artifactType !== "string" || artifactType.trim() !== "research_summary") {
      throw new Error("artifact.artifact_type must be research_summary");
    }
  }
  const contentJsonRaw = artifact.content_json;
  const contentJson =
    contentJsonRaw && typeof contentJsonRaw === "object" && !Array.isArray(contentJsonRaw)
      ? (contentJsonRaw as Record<string, unknown>)
      : {};
  const summaryFromArtifact = typeof artifact.summary === "string" ? artifact.summary.trim() : "";
  const summaryFromContentJson =
    typeof contentJson.business_summary === "string" ? contentJson.business_summary.trim() : "";
  const summary = summaryFromArtifact || summaryFromContentJson;
  if (!summary) {
    throw new Error("artifact.summary required");
  }

  const previewJson = {
    ...contentJson,
    schema_version: "v1",
    project_id: projectId,
    task_id: taskId,
    recommended_next_step: "builder_sitemap",
  };

  return {
    artifact_type: "research_summary",
    summary,
    task_id: taskId,
    schema_version: "v1",
    preview_json: previewJson,
  };
}

function buildRequestBody(spec: ToolSpec, params: ToolArgs): unknown {
  if (spec.name === "create_artifact") {
    return buildCreateArtifactBody(params);
  }
  if (spec.name === "attach_task_outputs") {
    const outputs = readRequiredObject(params, "outputs");
    const normalizedArtifactIds: string[] = [];

    const directOutputArtifactIds = outputs.output_artifact_ids;
    if (Array.isArray(directOutputArtifactIds)) {
      for (const rawId of directOutputArtifactIds) {
        if (typeof rawId === "string" && rawId.trim()) {
          normalizedArtifactIds.push(rawId.trim());
        }
      }
    }

    const legacyOutputs = outputs.outputs;
    if (Array.isArray(legacyOutputs)) {
      for (const rawOutput of legacyOutputs) {
        if (!rawOutput || typeof rawOutput !== "object") {
          continue;
        }
        const output = rawOutput as Record<string, unknown>;
        if (output.output_type !== "artifact") {
          continue;
        }
        const artifactId = output.artifact_id;
        if (typeof artifactId === "string" && artifactId.trim()) {
          normalizedArtifactIds.push(artifactId.trim());
        }
      }
    }

    const normalizedPayload: Record<string, unknown> = {};
    if (normalizedArtifactIds.length > 0) {
      normalizedPayload.output_artifact_ids = [...new Set(normalizedArtifactIds)];
    }
    if (
      outputs.output_payload &&
      typeof outputs.output_payload === "object" &&
      !Array.isArray(outputs.output_payload)
    ) {
      normalizedPayload.output_payload = outputs.output_payload;
    }
    if (typeof outputs.status === "string" && outputs.status.trim()) {
      normalizedPayload.status = outputs.status.trim();
    }

    if (Object.keys(normalizedPayload).length === 0) {
      throw new Error("outputs.output_artifact_ids required");
    }

    return normalizedPayload;
  }
  if (spec.name === "update_task_status") {
    const status = readRequiredObject(params, "status");
    const value = status.status;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("status.status required");
    }
    const body: Record<string, unknown> = { status: value.trim() };
    if (typeof status.failure_reason === "string" && status.failure_reason.trim()) {
      body.failure_reason = status.failure_reason.trim();
    }
    if (typeof status.failure_class === "string" && status.failure_class.trim()) {
      body.failure_class = status.failure_class.trim();
    }
    if (Number.isInteger(status.retry_count)) {
      body.retry_count = status.retry_count;
    }
    return body;
  }
  if (spec.name === "append_project_event") {
    const event = readRequiredObject(params, "event");
    const eventNameRaw = event.event ?? event.event_type;
    if (typeof eventNameRaw !== "string" || !eventNameRaw.trim()) {
      throw new Error("event.event required");
    }

    const body: Record<string, unknown> = {
      event: eventNameRaw.trim(),
      source:
        typeof event.source === "string" && event.source.trim()
          ? event.source.trim()
          : "gesahni-researcher",
    };
    if (typeof event.level === "string" && event.level.trim()) {
      body.level = event.level.trim();
    }
    if (typeof event.task_id === "string" && event.task_id.trim()) {
      body.task_id = event.task_id.trim();
    }

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (
        key === "event" ||
        key === "event_type" ||
        key === "source" ||
        key === "level" ||
        key === "task_id" ||
        key === "run_id"
      ) {
        continue;
      }
      payload[key] = value;
    }
    if (Object.keys(payload).length > 0) {
      body.payload = payload;
    }

    return body;
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
  if (path.includes("{task_id}")) {
    path = path.replaceAll("{task_id}", encodeURIComponent(readRequiredString(params, "task_id")));
  }
  if (path.includes("{run_id}")) {
    const runId = readOptionalString(params, "run_id");
    if (runId) {
      path = path.replaceAll("{run_id}", encodeURIComponent(runId));
    } else {
      path = path.replace("/runs/{run_id}", "");
    }
  }
  return path;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function buildBridgeResult(
  payload: Awaited<ReturnType<ReturnType<typeof createGesahniResearcherClient>["request"]>>,
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

export function createGesahniResearcherTools(
  api: Pick<OpenClawPluginApi, "pluginConfig">,
  options?: { fetchImpl?: typeof fetch },
): AnyAgentTool[] {
  const client = createGesahniResearcherClient({
    config: resolveGesahniResearcherConfig(api),
    fetchImpl: options?.fetchImpl,
  });

  return TOOL_SPECS.map((spec) => ({
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
}
