import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { createLinearTools } from "./linear-tools.js";

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "linear",
    name: "linear",
    source: "test",
    config: {},
    pluginConfig: { apiKey: "lin_api_test123" },
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  } as unknown as OpenClawPluginApi;
}

function findTool(tools: ReturnType<typeof createLinearTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

describe("linear tools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates four tools", () => {
    const tools = createLinearTools(fakeApi());
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "linear_search_issues",
      "linear_create_issue",
      "linear_list_teams",
      "linear_get_issue",
    ]);
  });

  describe("linear_search_issues", () => {
    it("returns formatted results", async () => {
      const mockData = {
        data: {
          issues: {
            nodes: [
              {
                id: "id1",
                identifier: "ENG-42",
                title: "Fix login bug",
                state: { name: "In Progress" },
                assignee: { name: "Alice" },
                priority: 2,
                priorityLabel: "High",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                url: "https://linear.app/team/issue/ENG-42",
              },
            ],
          },
        },
      };

      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      const result = await tool.execute("call1", { query: "login" });

      expect(result.content[0].text).toContain("ENG-42");
      expect(result.content[0].text).toContain("Fix login bug");
      expect(result.content[0].text).toContain("In Progress");
      expect(result.content[0].text).toContain("Alice");
    });

    it("passes team filter in GraphQL variables", async () => {
      const mockData = { data: { issues: { nodes: [] } } };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      await tool.execute("call2", { query: "test", teamKey: "ENG" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.variables.filter.team).toEqual({ key: { eq: "ENG" } });
    });

    it("respects limit parameter", async () => {
      const mockData = { data: { issues: { nodes: [] } } };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      await tool.execute("call3", { query: "test", limit: 5 });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.variables.limit).toBe(5);
    });

    it("returns no-results message when empty", async () => {
      const mockData = { data: { issues: { nodes: [] } } };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      const result = await tool.execute("call4", { query: "nonexistent" });

      expect(result.content[0].text).toContain("No issues found");
    });
  });

  describe("linear_create_issue", () => {
    it("sends correct mutation and returns issue details", async () => {
      // First call resolves team, second call creates issue
      const teamResponse = {
        data: { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } },
      };
      const createResponse = {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "ENG-100",
              title: "New feature",
              url: "https://linear.app/team/issue/ENG-100",
              state: { name: "Backlog" },
            },
          },
        },
      };

      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => {
          const data = callCount === 0 ? teamResponse : createResponse;
          callCount++;
          return {
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => JSON.stringify(data),
          };
        }),
      );

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_create_issue");
      const result = await tool.execute("call5", {
        title: "New feature",
        teamKey: "ENG",
        description: "Implement the thing",
        priority: 2,
      });

      expect(result.content[0].text).toContain("ENG-100");
      expect(result.content[0].text).toContain("New feature");
      expect(result.content[0].text).toContain("Backlog");
    });

    it("throws when team not found", async () => {
      const teamResponse = { data: { teams: { nodes: [] } } };
      vi.stubGlobal("fetch", mockFetchResponse(teamResponse));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_create_issue");
      await expect(tool.execute("call6", { title: "Test", teamKey: "NOPE" })).rejects.toThrow(
        /Team with key 'NOPE' not found/,
      );
    });
  });

  describe("linear_list_teams", () => {
    it("returns team list", async () => {
      const mockData = {
        data: {
          teams: {
            nodes: [
              { id: "t1", key: "ENG", name: "Engineering", description: "Core team" },
              { id: "t2", key: "DES", name: "Design" },
            ],
          },
        },
      };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_list_teams");
      const result = await tool.execute("call7", {});

      expect(result.content[0].text).toContain("ENG: Engineering");
      expect(result.content[0].text).toContain("Core team");
      expect(result.content[0].text).toContain("DES: Design");
    });

    it("returns message when no teams", async () => {
      const mockData = { data: { teams: { nodes: [] } } };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_list_teams");
      const result = await tool.execute("call8", {});

      expect(result.content[0].text).toContain("No teams found");
    });
  });

  describe("linear_get_issue", () => {
    it("returns detailed issue info with comments", async () => {
      const mockData = {
        data: {
          issueSearch: {
            nodes: [
              {
                id: "id1",
                identifier: "ENG-42",
                title: "Fix login bug",
                description: "The login form breaks on mobile.",
                state: { name: "In Progress" },
                assignee: { name: "Alice" },
                priority: 2,
                priorityLabel: "High",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                url: "https://linear.app/team/issue/ENG-42",
                comments: {
                  nodes: [
                    {
                      body: "Working on it",
                      user: { name: "Alice" },
                      createdAt: "2024-01-01T12:00:00Z",
                    },
                  ],
                },
              },
            ],
          },
        },
      };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_get_issue");
      const result = await tool.execute("call9", { identifier: "ENG-42" });

      expect(result.content[0].text).toContain("ENG-42: Fix login bug");
      expect(result.content[0].text).toContain("In Progress");
      expect(result.content[0].text).toContain("The login form breaks on mobile");
      expect(result.content[0].text).toContain("[Alice] Working on it");
    });

    it("returns not-found message for missing issue", async () => {
      const mockData = { data: { issueSearch: { nodes: [] } } };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_get_issue");
      const result = await tool.execute("call10", { identifier: "NOPE-999" });

      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("error handling", () => {
    it("throws when apiKey is missing", async () => {
      const tools = createLinearTools(fakeApi({ pluginConfig: {} }));
      const tool = findTool(tools, "linear_search_issues");
      await expect(tool.execute("call11", { query: "test" })).rejects.toThrow(
        /API key not configured/,
      );
    });

    it("throws on HTTP error response", async () => {
      vi.stubGlobal("fetch", mockFetchResponse({}, false, 401));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      await expect(tool.execute("call12", { query: "test" })).rejects.toThrow(
        /Linear API error \(401\)/,
      );
    });

    it("throws on GraphQL error response", async () => {
      const mockData = { errors: [{ message: "Authentication required" }] };
      vi.stubGlobal("fetch", mockFetchResponse(mockData));

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      await expect(tool.execute("call13", { query: "test" })).rejects.toThrow(
        /GraphQL error.*Authentication required/,
      );
    });

    it("sends Authorization header with apiKey", async () => {
      const mockData = { data: { issues: { nodes: [] } } };
      const fetchMock = mockFetchResponse(mockData);
      vi.stubGlobal("fetch", fetchMock);

      const tools = createLinearTools(fakeApi());
      const tool = findTool(tools, "linear_search_issues");
      await tool.execute("call14", { query: "test" });

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("lin_api_test123");
    });
  });
});
