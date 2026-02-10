import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

type LinearPluginConfig = {
  apiKey?: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

async function linearGraphQL<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linear API error (${res.status}): ${body || res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("Linear API returned no data");
  }
  return json.data;
}

function resolveApiKey(api: OpenClawPluginApi): string {
  const cfg = api.pluginConfig as LinearPluginConfig | undefined;
  const apiKey = cfg?.apiKey;
  if (!apiKey) {
    throw new Error(
      "Linear API key not configured. Set it in plugins.entries.linear.config.apiKey",
    );
  }
  return apiKey;
}

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  state: { name: string } | null;
  assignee: { name: string } | null;
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  description?: string;
};

type CommentNode = {
  body: string;
  user: { name: string } | null;
  createdAt: string;
};

function formatIssue(issue: IssueNode): string {
  const parts = [
    `${issue.identifier}: ${issue.title}`,
    `  Status: ${issue.state?.name ?? "Unknown"}`,
    `  Priority: ${issue.priorityLabel}`,
    issue.assignee ? `  Assignee: ${issue.assignee.name}` : null,
    `  URL: ${issue.url}`,
  ];
  return parts.filter(Boolean).join("\n");
}

export function createLinearTools(api: OpenClawPluginApi) {
  const searchIssues = {
    name: "linear_search_issues",
    description: "Search Linear issues with optional filters for team, status, and assignee.",
    parameters: Type.Object({
      query: Type.String({ description: "Search text to find in issue titles and descriptions" }),
      teamKey: Type.Optional(Type.String({ description: "Filter by team key (e.g. 'ENG')" })),
      status: Type.Optional(
        Type.String({ description: "Filter by status name (e.g. 'In Progress', 'Done')" }),
      ),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee display name" })),
      limit: Type.Optional(
        Type.Number({ description: "Max results to return (default 10)", minimum: 1, maximum: 50 }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const apiKey = resolveApiKey(api);
      const query = params.query as string;
      const teamKey = params.teamKey as string | undefined;
      const status = params.status as string | undefined;
      const assignee = params.assignee as string | undefined;
      const limit = (params.limit as number) || 10;

      // Build filter object
      const filter: Record<string, unknown> = {};
      if (query) filter.searchableContent = { contains: query };
      if (teamKey) filter.team = { key: { eq: teamKey } };
      if (status) filter.state = { name: { eqCaseInsensitive: status } };
      if (assignee) filter.assignee = { displayName: { containsIgnoreCase: assignee } };

      const gql = `
        query SearchIssues($filter: IssueFilter, $limit: Int) {
          issues(filter: $filter, first: $limit) {
            nodes {
              id identifier title
              state { name }
              assignee { name }
              priority priorityLabel
              createdAt updatedAt url
            }
          }
        }
      `;

      type SearchResult = { issues: { nodes: IssueNode[] } };
      const data = await linearGraphQL<SearchResult>(apiKey, gql, { filter, limit });
      const issues = data.issues.nodes;

      if (issues.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No issues found matching your query." }],
        };
      }

      const formatted = issues.map(formatIssue).join("\n\n");
      return {
        content: [
          { type: "text" as const, text: `Found ${issues.length} issue(s):\n\n${formatted}` },
        ],
      };
    },
  };

  const createIssue = {
    name: "linear_create_issue",
    description: "Create a new issue in Linear.",
    parameters: Type.Object({
      title: Type.String({ description: "Issue title" }),
      teamKey: Type.String({ description: "Team key (e.g. 'ENG')" }),
      description: Type.Optional(Type.String({ description: "Issue description (markdown)" })),
      priority: Type.Optional(
        Type.Number({
          description: "Priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
          minimum: 0,
          maximum: 4,
        }),
      ),
      assigneeId: Type.Optional(Type.String({ description: "Assignee user ID" })),
      labelIds: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to apply" })),
      stateId: Type.Optional(Type.String({ description: "Workflow state ID" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const apiKey = resolveApiKey(api);
      const title = params.title as string;
      const teamKey = params.teamKey as string;

      // Resolve team ID from key
      const teamGql = `
        query GetTeam($key: String!) {
          teams(filter: { key: { eq: $key } }) {
            nodes { id key name }
          }
        }
      `;
      type TeamResult = { teams: { nodes: Array<{ id: string; key: string; name: string }> } };
      const teamData = await linearGraphQL<TeamResult>(apiKey, teamGql, { key: teamKey });
      const team = teamData.teams.nodes[0];
      if (!team) {
        throw new Error(`Team with key '${teamKey}' not found`);
      }

      const input: Record<string, unknown> = {
        title,
        teamId: team.id,
      };
      if (params.description) input.description = params.description;
      if (typeof params.priority === "number") input.priority = params.priority;
      if (params.assigneeId) input.assigneeId = params.assigneeId;
      if (params.labelIds) input.labelIds = params.labelIds;
      if (params.stateId) input.stateId = params.stateId;

      const gql = `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id identifier title url
              state { name }
            }
          }
        }
      `;

      type CreateResult = {
        issueCreate: {
          success: boolean;
          issue: {
            id: string;
            identifier: string;
            title: string;
            url: string;
            state: { name: string } | null;
          };
        };
      };
      const data = await linearGraphQL<CreateResult>(apiKey, gql, { input });

      if (!data.issueCreate.success) {
        throw new Error("Failed to create issue");
      }

      const issue = data.issueCreate.issue;
      return {
        content: [
          {
            type: "text" as const,
            text: `Created issue ${issue.identifier}: ${issue.title}\nStatus: ${issue.state?.name ?? "Unknown"}\nURL: ${issue.url}`,
          },
        ],
      };
    },
  };

  const listTeams = {
    name: "linear_list_teams",
    description: "List all teams in your Linear workspace.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>) {
      const apiKey = resolveApiKey(api);

      const gql = `
        query ListTeams {
          teams {
            nodes { id key name description }
          }
        }
      `;

      type TeamsResult = {
        teams: { nodes: Array<{ id: string; key: string; name: string; description?: string }> };
      };
      const data = await linearGraphQL<TeamsResult>(apiKey, gql);
      const teams = data.teams.nodes;

      if (teams.length === 0) {
        return { content: [{ type: "text" as const, text: "No teams found." }] };
      }

      const formatted = teams
        .map((t) => `${t.key}: ${t.name}${t.description ? ` — ${t.description}` : ""}`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: `Teams (${teams.length}):\n\n${formatted}` }],
      };
    },
  };

  const getIssue = {
    name: "linear_get_issue",
    description:
      "Get detailed information about a specific Linear issue by its identifier (e.g. 'ENG-123').",
    parameters: Type.Object({
      identifier: Type.String({ description: "Issue identifier (e.g. 'ENG-123')" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const apiKey = resolveApiKey(api);
      const identifier = params.identifier as string;

      const gql = `
        query GetIssue($identifier: String!) {
          issueSearch(query: $identifier, first: 1) {
            nodes {
              id identifier title description
              state { name }
              assignee { name }
              priority priorityLabel
              createdAt updatedAt url
              comments {
                nodes {
                  body
                  user { name }
                  createdAt
                }
              }
            }
          }
        }
      `;

      type IssueWithComments = IssueNode & {
        comments: { nodes: CommentNode[] };
      };
      type GetResult = { issueSearch: { nodes: IssueWithComments[] } };
      const data = await linearGraphQL<GetResult>(apiKey, gql, { identifier });

      const issue = data.issueSearch.nodes[0];
      if (!issue) {
        return { content: [{ type: "text" as const, text: `Issue '${identifier}' not found.` }] };
      }

      const parts = [
        `${issue.identifier}: ${issue.title}`,
        `Status: ${issue.state?.name ?? "Unknown"}`,
        `Priority: ${issue.priorityLabel}`,
        issue.assignee ? `Assignee: ${issue.assignee.name}` : null,
        `Created: ${issue.createdAt}`,
        `Updated: ${issue.updatedAt}`,
        `URL: ${issue.url}`,
      ].filter(Boolean);

      if (issue.description) {
        parts.push("", "Description:", issue.description);
      }

      if (issue.comments.nodes.length > 0) {
        parts.push("", `Comments (${issue.comments.nodes.length}):`);
        for (const c of issue.comments.nodes) {
          parts.push(`  [${c.user?.name ?? "Unknown"}] ${c.body}`);
        }
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    },
  };

  return [searchIssues, createIssue, listTeams, getIssue];
}
