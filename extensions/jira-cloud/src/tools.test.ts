import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveJiraCloudConfig = vi.hoisted(() => vi.fn());
const JiraCloudClient = vi.hoisted(() =>
  vi.fn().mockImplementation(function MockedJiraCloudClient() {
    return {
      getSecrets: () => ["secret-token"],
    };
  }),
);
const createJiraService = vi.hoisted(() => vi.fn());

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveJiraCloudConfig,
  };
});

vi.mock("./client.js", () => ({
  JiraCloudClient,
}));

vi.mock("./jira-service.js", () => ({
  createJiraService,
}));

describe("jira tools", () => {
  beforeEach(() => {
    resolveJiraCloudConfig.mockReset();
    JiraCloudClient.mockClear();
    createJiraService.mockReset();
    resolveJiraCloudConfig.mockReturnValue({
      siteUrl: "https://example.atlassian.net",
      email: "bot@example.com",
      apiToken: "secret-token",
      defaultProjectKey: "OPS",
      defaultIssueType: "Task",
      requestTimeoutMs: 15_000,
      retryCount: 2,
      userAgent: "openclaw-jira-cloud/test",
    });
    createJiraService.mockReturnValue({
      healthcheck: vi.fn(async () => ({ status: "ok" })),
      listProjects: vi.fn(async () => ({ projects: [] })),
      searchIssues: vi.fn(async () => ({ issues: [], total: 0, startAt: 0, maxResults: 20 })),
      getIssue: vi.fn(async () => ({ issue: { key: "OPS-1" } })),
      createIssue: vi.fn(async () => ({ key: "OPS-2" })),
      addComment: vi.fn(async () => ({ issueKey: "OPS-2", commentId: "10100" })),
      listTransitions: vi.fn(async () => ({ transitions: [] })),
      transitionIssue: vi.fn(async () => ({ transitioned: true })),
      assignIssue: vi.fn(async () => ({ assigned: true })),
      getCreateMetadata: vi.fn(async () => ({ issueTypes: [] })),
    });
  });

  it("registers all jira tools", async () => {
    const { createJiraCloudTools } = await import("./tools.js");
    const tools = createJiraCloudTools({ config: {} } as never);
    expect(tools.map((tool) => tool.name)).toEqual([
      "jira_healthcheck",
      "jira_list_projects",
      "jira_search_issues",
      "jira_get_issue",
      "jira_create_issue",
      "jira_add_comment",
      "jira_list_transitions",
      "jira_transition_issue",
      "jira_assign_issue",
      "jira_get_create_metadata",
    ]);
  });

  it("validates issue keys on mutating tools", async () => {
    const { createJiraCloudTools } = await import("./tools.js");
    const tools = createJiraCloudTools({ config: {} } as never);
    const addCommentTool = tools.find((tool) => tool.name === "jira_add_comment");
    if (!addCommentTool?.execute) {
      throw new Error("jira_add_comment tool missing");
    }

    const result = (await addCommentTool.execute("1", {
      issueKey: "invalid",
      comment: "hello",
    })) as { details?: { code?: string }; content?: Array<{ text?: string }> };
    expect(result.details).toMatchObject({
      code: "jira_validation_failed",
    });
  });

  it("returns sanitized failures when config is missing", async () => {
    resolveJiraCloudConfig.mockImplementation(() => {
      throw new Error("token secret-token missing");
    });
    const { createJiraCloudTools } = await import("./tools.js");
    const tools = createJiraCloudTools({ config: {} } as never);
    const healthTool = tools.find((tool) => tool.name === "jira_healthcheck");
    if (!healthTool?.execute) {
      throw new Error("jira_healthcheck tool missing");
    }
    const result = (await healthTool.execute("1", {})) as { details?: { message?: string } };
    expect(result.details?.message).not.toContain("secret-token");
  });
});
