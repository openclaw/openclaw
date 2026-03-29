import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("jira-cloud plugin registration", () => {
  it("registers jira tools", () => {
    const toolNames: string[] = [];
    const mockApi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      config: {
        plugins: {
          entries: {
            "jira-cloud": {
              config: {
                siteUrl: "https://example.atlassian.net",
                email: "bot@example.com",
                apiToken: "secret-token",
              },
            },
          },
        },
      },
    };

    plugin.register(mockApi as never);

    expect(plugin.id).toBe("jira-cloud");
    expect(toolNames).toHaveLength(10);
    expect(toolNames).toContain("jira_healthcheck");
    expect(toolNames).toContain("jira_transition_issue");
  });
});

