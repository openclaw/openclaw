import { DEFAULT_SEARCH_FIELDS } from "./config.js";
import type { JiraCloudClient } from "./client.js";

export type JiraIssueSummary = {
  id?: string;
  key: string;
  summary?: string;
  status?: string;
  issueType?: string;
  assignee?: string;
  priority?: string;
  updated?: string;
};

type JiraIssueLike = {
  id?: string;
  key?: string;
  fields?: Record<string, unknown>;
};

function toAdfDocument(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function summarizeIssue(issue: JiraIssueLike): JiraIssueSummary {
  const fields = issue.fields ?? {};
  const status = readString((fields.status as { name?: unknown } | undefined)?.name);
  const issueType = readString((fields.issuetype as { name?: unknown } | undefined)?.name);
  const assignee = readString((fields.assignee as { displayName?: unknown } | undefined)?.displayName);
  const priority = readString((fields.priority as { name?: unknown } | undefined)?.name);
  return {
    id: readString(issue.id),
    key: readString(issue.key) ?? "",
    summary: readString(fields.summary),
    status,
    issueType,
    assignee,
    priority,
    updated: readString(fields.updated),
  };
}

function safeIssueUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl}/browse/${issueKey}`;
}

export function createJiraService(client: JiraCloudClient) {
  return {
    async healthcheck() {
      const myself = await client.request<{
        accountId?: string;
        displayName?: string;
        emailAddress?: string;
      }>("/rest/api/3/myself");
      return {
        site: client.getSiteUrl(),
        status: "ok",
        timestamp: new Date().toISOString(),
        authenticatedUser: {
          accountId: readString(myself.accountId),
          displayName: readString(myself.displayName),
          emailAddress: readString(myself.emailAddress),
        },
      };
    },

    async listProjects(maxResults: number) {
      const payload = await client.request<{
        values?: Array<{
          id?: string;
          key?: string;
          name?: string;
          simplified?: boolean;
          projectTypeKey?: string;
        }>;
      }>("/rest/api/3/project/search", {
        query: { maxResults },
      });
      return {
        projects: (payload.values ?? []).map((project) => ({
          id: readString(project.id),
          key: readString(project.key),
          name: readString(project.name),
          simplified: project.simplified === true,
          projectTypeKey: readString(project.projectTypeKey),
        })),
      };
    },

    async searchIssues(params: {
      jql: string;
      maxResults: number;
      fields?: string[];
      startAt?: number;
    }) {
      const payload = await client.request<{
        startAt?: number;
        maxResults?: number;
        total?: number;
        issues?: JiraIssueLike[];
      }>("/rest/api/3/search", {
        method: "POST",
        body: {
          jql: params.jql,
          maxResults: params.maxResults,
          startAt: params.startAt ?? 0,
          fields: params.fields?.length ? params.fields : DEFAULT_SEARCH_FIELDS,
        },
      });
      return {
        total: payload.total ?? 0,
        startAt: payload.startAt ?? 0,
        maxResults: payload.maxResults ?? params.maxResults,
        issues: (payload.issues ?? []).map((issue) => summarizeIssue(issue)),
      };
    },

    async getIssue(issueKey: string, fields?: string[]) {
      const issue = await client.request<JiraIssueLike>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        query: {
          fields: fields?.length ? fields.join(",") : DEFAULT_SEARCH_FIELDS.join(","),
        },
      });
      return {
        issue: {
          ...summarizeIssue(issue),
          fields: issue.fields ?? {},
          url: safeIssueUrl(client.getSiteUrl(), issueKey),
        },
      };
    },

    async createIssue(params: {
      projectKey: string;
      issueType: string;
      summary: string;
      description?: string;
      priority?: string;
      labels?: string[];
      assigneeAccountId?: string;
    }) {
      const fields: Record<string, unknown> = {
        project: { key: params.projectKey },
        issuetype: { name: params.issueType },
        summary: params.summary,
      };
      if (params.description) {
        fields.description = toAdfDocument(params.description);
      }
      if (params.priority) {
        fields.priority = { name: params.priority };
      }
      if (params.labels?.length) {
        fields.labels = params.labels;
      }
      if (params.assigneeAccountId) {
        fields.assignee = { accountId: params.assigneeAccountId };
      }

      const created = await client.request<{ id?: string; key?: string }>("/rest/api/3/issue", {
        method: "POST",
        body: { fields },
      });
      const key = readString(created.key) ?? "";
      const detail = key
        ? await this.getIssue(key, ["summary", "status", "issuetype", "assignee", "project"])
        : null;
      return {
        id: readString(created.id),
        key,
        url: key ? safeIssueUrl(client.getSiteUrl(), key) : undefined,
        summary: detail?.issue.summary,
        status: detail?.issue.status,
      };
    },

    async addComment(issueKey: string, comment: string) {
      const payload = await client.request<{ id?: string }>("/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/comment", {
        method: "POST",
        body: { body: toAdfDocument(comment) },
      });
      const commentId = readString(payload.id);
      return {
        issueKey,
        commentId,
        url: commentId
          ? `${safeIssueUrl(client.getSiteUrl(), issueKey)}?focusedCommentId=${commentId}`
          : safeIssueUrl(client.getSiteUrl(), issueKey),
      };
    },

    async listTransitions(issueKey: string) {
      const payload = await client.request<{
        transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }>;
      }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
      return {
        issueKey,
        transitions: (payload.transitions ?? []).map((transition) => ({
          id: readString(transition.id),
          name: readString(transition.name),
          toStatus: readString(transition.to?.name),
        })),
      };
    },

    async transitionIssue(params: { issueKey: string; transitionId: string; comment?: string }) {
      const body: Record<string, unknown> = {
        transition: { id: params.transitionId },
      };
      if (params.comment) {
        body.update = {
          comment: [{ add: { body: toAdfDocument(params.comment) } }],
        };
      }
      await client.request<void>(`/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/transitions`, {
        method: "POST",
        body,
      });
      const detail = await this.getIssue(params.issueKey, ["status", "summary"]);
      return {
        issueKey: params.issueKey,
        transitioned: true,
        status: detail.issue.status,
      };
    },

    async assignIssue(params: { issueKey: string; accountId: string }) {
      await client.request<void>(`/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/assignee`, {
        method: "PUT",
        body: { accountId: params.accountId },
      });
      const detail = await this.getIssue(params.issueKey, ["assignee"]);
      return {
        issueKey: params.issueKey,
        assigned: true,
        assignee: detail.issue.assignee,
      };
    },

    async getCreateMetadata(params: { projectKey?: string; issueType?: string }) {
      const projectKey = params.projectKey;
      const issueTypesPayload = projectKey
        ? await client.request<{ issueTypes?: Array<{ id?: string; name?: string }> }>(
            `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
          )
        : { issueTypes: [] };
      const issueTypes = (issueTypesPayload.issueTypes ?? []).map((issueType) => ({
        id: readString(issueType.id),
        name: readString(issueType.name),
      }));

      let issueTypeFields: unknown = undefined;
      if (projectKey && params.issueType) {
        const matchedIssueType = issueTypes.find(
          (entry) =>
            entry.id === params.issueType ||
            entry.name?.toLowerCase() === params.issueType?.toLowerCase(),
        );
        if (matchedIssueType?.id) {
          issueTypeFields = await client.request<Record<string, unknown>>(
            `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(
              matchedIssueType.id,
            )}`,
          );
        }
      }

      return {
        projectKey,
        issueTypes,
        issueTypeFields,
      };
    },
  };
}

