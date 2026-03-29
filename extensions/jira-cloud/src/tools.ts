import type { AnyAgentTool, OpenClawPluginApi } from "../runtime-api.js";
import {
  Type,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../runtime-api.js";
import { resolveAllowedJiraFields, resolveJiraCloudConfig } from "./config.js";
import { JiraCloudClient } from "./client.js";
import { createJiraService } from "./jira-service.js";
import { JiraApiError, normalizeJiraError } from "./errors.js";

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,49}$/i;

const DEFAULT_MAX_RESULTS = 20;
const MAX_MAX_RESULTS = 50;

function optionalStringArray(description: string) {
  return Type.Optional(Type.Array(Type.String(), { description }));
}

function validateIssueKey(issueKey: string): string {
  const normalized = issueKey.trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(normalized)) {
    throw new JiraApiError(
      "issueKey must be a valid Jira key (e.g. PROJ-123).",
      "jira_validation_failed",
      400,
      false,
    );
  }
  return normalized;
}

function validateProjectKey(projectKey: string): string {
  const normalized = projectKey.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(normalized)) {
    throw new JiraApiError(
      "projectKey must be a valid Jira project key.",
      "jira_validation_failed",
      400,
      false,
    );
  }
  return normalized;
}

function normalizeMaxResults(rawParams: Record<string, unknown>): number {
  const value = readNumberParam(rawParams, "maxResults", { integer: true }) ?? DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_MAX_RESULTS, value));
}

function createToolSchemas() {
  return {
    healthcheck: Type.Object({}, { additionalProperties: false }),
    listProjects: Type.Object(
      {
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_MAX_RESULTS })),
      },
      { additionalProperties: false },
    ),
    searchIssues: Type.Object(
      {
        jql: Type.String({ minLength: 1 }),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_MAX_RESULTS })),
        fields: optionalStringArray("Optional Jira fields allowlist."),
      },
      { additionalProperties: false },
    ),
    getIssue: Type.Object(
      {
        issueKey: Type.String({ minLength: 1 }),
        fields: optionalStringArray("Optional Jira fields allowlist."),
      },
      { additionalProperties: false },
    ),
    createIssue: Type.Object(
      {
        projectKey: Type.Optional(Type.String({ minLength: 1 })),
        issueType: Type.Optional(Type.String({ minLength: 1 })),
        summary: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        priority: Type.Optional(Type.String()),
        labels: optionalStringArray("Issue labels."),
        assigneeAccountId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    addComment: Type.Object(
      {
        issueKey: Type.String({ minLength: 1 }),
        comment: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    listTransitions: Type.Object(
      {
        issueKey: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    transitionIssue: Type.Object(
      {
        issueKey: Type.String({ minLength: 1 }),
        transitionId: Type.String({ minLength: 1 }),
        comment: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    assignIssue: Type.Object(
      {
        issueKey: Type.String({ minLength: 1 }),
        accountId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    getCreateMetadata: Type.Object(
      {
        projectKey: Type.Optional(Type.String()),
        issueType: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  };
}

type JiraToolExecutionContext = {
  config: ReturnType<typeof resolveJiraCloudConfig>;
  client: JiraCloudClient;
  service: ReturnType<typeof createJiraService>;
};

type JiraToolResult = ReturnType<typeof jsonResult>;

type JiraToolExecutor = (
  toolCallId: string,
  rawParams: Record<string, unknown>,
  context: JiraToolExecutionContext,
) => Promise<JiraToolResult>;

function createExecutionContext(api: OpenClawPluginApi): JiraToolExecutionContext {
  const config = resolveJiraCloudConfig({ cfg: api.config });
  const client = new JiraCloudClient(config);
  const service = createJiraService(client);
  return { config, client, service };
}

function wrapToolExecution(
  api: OpenClawPluginApi,
  execute: JiraToolExecutor,
): (toolCallId: string, rawParams: Record<string, unknown>) => Promise<JiraToolResult> {
  return async (toolCallId: string, rawParams: Record<string, unknown>) => {
    let context: JiraToolExecutionContext | null = null;
    try {
      context = createExecutionContext(api);
      return await execute(toolCallId, rawParams, context);
    } catch (error) {
      const errorName =
        error && typeof error === "object" && "name" in error ? String(error.name) : "";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const validationLike =
        errorName === "ToolInputError" ||
        /required|issuekey|projectkey|invalid/i.test(errorMessage);
      const payload = normalizeJiraError(error, {
        secrets: context?.client.getSecrets() ?? [],
        fallbackCode: validationLike ? "jira_validation_failed" : "jira_request_failed",
      });
      return jsonResult(payload);
    }
  };
}

export function createJiraCloudTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const schemas = createToolSchemas();

  const tools: AnyAgentTool[] = [
    {
      name: "jira_healthcheck",
      label: "Jira Healthcheck",
      description: "Validate Jira Cloud authentication and connectivity.",
      parameters: schemas.healthcheck,
      execute: wrapToolExecution(api, async (_toolCallId, _rawParams, context) =>
        jsonResult(await context.service.healthcheck()),
      ),
    },
    {
      name: "jira_list_projects",
      label: "Jira List Projects",
      description: "List Jira projects accessible with the configured account.",
      parameters: schemas.listProjects,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const payload = await context.service.listProjects(normalizeMaxResults(rawParams));
        return jsonResult(payload);
      }),
    },
    {
      name: "jira_search_issues",
      label: "Jira Search Issues",
      description: "Search Jira issues using JQL.",
      parameters: schemas.searchIssues,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const jql = readStringParam(rawParams, "jql", { required: true });
        const fields = resolveAllowedJiraFields(readStringArrayParam(rawParams, "fields"));
        const payload = await context.service.searchIssues({
          jql,
          maxResults: normalizeMaxResults(rawParams),
          fields: fields.length ? fields : undefined,
        });
        return jsonResult(payload);
      }),
    },
    {
      name: "jira_get_issue",
      label: "Jira Get Issue",
      description: "Get detailed information for one Jira issue key.",
      parameters: schemas.getIssue,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const issueKey = validateIssueKey(readStringParam(rawParams, "issueKey", { required: true }));
        const fields = resolveAllowedJiraFields(readStringArrayParam(rawParams, "fields"));
        return jsonResult(await context.service.getIssue(issueKey, fields.length ? fields : undefined));
      }),
    },
    {
      name: "jira_create_issue",
      label: "Jira Create Issue",
      description: "Create a Jira issue in the target project.",
      parameters: schemas.createIssue,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const summary = readStringParam(rawParams, "summary", { required: true });
        const projectKey = validateProjectKey(
          readStringParam(rawParams, "projectKey") ?? context.config.defaultProjectKey ?? "",
        );
        const issueType = readStringParam(rawParams, "issueType") ?? context.config.defaultIssueType;
        if (!issueType) {
          throw new Error(
            "issueType is required when defaultIssueType is not configured in jira-cloud config.",
          );
        }
        const description = readStringParam(rawParams, "description");
        const priority = readStringParam(rawParams, "priority");
        const labels = readStringArrayParam(rawParams, "labels");
        const assigneeAccountId = readStringParam(rawParams, "assigneeAccountId");
        return jsonResult(
          await context.service.createIssue({
            projectKey,
            issueType,
            summary,
            description,
            priority,
            labels,
            assigneeAccountId,
          }),
        );
      }),
    },
    {
      name: "jira_add_comment",
      label: "Jira Add Comment",
      description: "Add a comment to a Jira issue.",
      parameters: schemas.addComment,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const issueKey = validateIssueKey(readStringParam(rawParams, "issueKey", { required: true }));
        const comment = readStringParam(rawParams, "comment", { required: true });
        return jsonResult(await context.service.addComment(issueKey, comment));
      }),
    },
    {
      name: "jira_list_transitions",
      label: "Jira List Transitions",
      description: "List available transitions for a Jira issue.",
      parameters: schemas.listTransitions,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const issueKey = validateIssueKey(readStringParam(rawParams, "issueKey", { required: true }));
        return jsonResult(await context.service.listTransitions(issueKey));
      }),
    },
    {
      name: "jira_transition_issue",
      label: "Jira Transition Issue",
      description: "Transition a Jira issue to a new workflow state.",
      parameters: schemas.transitionIssue,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const issueKey = validateIssueKey(readStringParam(rawParams, "issueKey", { required: true }));
        const transitionId = readStringParam(rawParams, "transitionId", { required: true });
        const comment = readStringParam(rawParams, "comment");
        return jsonResult(await context.service.transitionIssue({ issueKey, transitionId, comment }));
      }),
    },
    {
      name: "jira_assign_issue",
      label: "Jira Assign Issue",
      description: "Assign a Jira issue to an accountId.",
      parameters: schemas.assignIssue,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const issueKey = validateIssueKey(readStringParam(rawParams, "issueKey", { required: true }));
        const accountId = readStringParam(rawParams, "accountId", { required: true });
        return jsonResult(await context.service.assignIssue({ issueKey, accountId }));
      }),
    },
    {
      name: "jira_get_create_metadata",
      label: "Jira Get Create Metadata",
      description: "Fetch issue-type metadata for issue creation.",
      parameters: schemas.getCreateMetadata,
      execute: wrapToolExecution(api, async (_toolCallId, rawParams, context) => {
        const projectKeyRaw = readStringParam(rawParams, "projectKey");
        const issueType = readStringParam(rawParams, "issueType");
        const projectKey = projectKeyRaw
          ? validateProjectKey(projectKeyRaw)
          : context.config.defaultProjectKey;
        return jsonResult(await context.service.getCreateMetadata({ projectKey, issueType }));
      }),
    },
  ];

  return tools;
}
