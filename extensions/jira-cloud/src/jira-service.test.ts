import { describe, expect, it, vi } from "vitest";
import { JiraApiError } from "./errors.js";
import { createJiraService } from "./jira-service.js";

describe("jira service", () => {
  it("converts create issue description from plain text to minimal adf", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: "1001", key: "OPS-1" })
      .mockResolvedValueOnce({
        key: "OPS-1",
        fields: { summary: "A", status: { name: "To Do" } },
      });
    const service = createJiraService({
      request,
      getSiteUrl: () => "https://example.atlassian.net",
    } as never);

    await service.createIssue({
      projectKey: "OPS",
      issueType: "Bug",
      summary: "Broken",
      description: "line1\nline2",
    });

    const createBody = request.mock.calls[0]?.[1]?.body as { fields?: Record<string, unknown> };
    expect(createBody.fields?.description).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line1" }] },
        { type: "paragraph", content: [{ type: "text", text: "line2" }] },
      ],
    });
  });

  it("converts add comment plain text to minimal adf", async () => {
    const request = vi.fn().mockResolvedValue({ id: "2002" });
    const service = createJiraService({
      request,
      getSiteUrl: () => "https://example.atlassian.net",
    } as never);

    await service.addComment("OPS-2", "hello");
    const commentBody = request.mock.calls[0]?.[1]?.body as { body?: unknown };
    expect(commentBody.body).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("converts transition comment plain text to minimal adf", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ key: "OPS-3", fields: { status: { name: "In Progress" } } });
    const service = createJiraService({
      request,
      getSiteUrl: () => "https://example.atlassian.net",
    } as never);

    await service.transitionIssue({
      issueKey: "OPS-3",
      transitionId: "31",
      comment: "moving now",
    });

    const transitionBody = request.mock.calls[0]?.[1]?.body as { update?: unknown };
    expect(transitionBody.update).toEqual({
      comment: [
        {
          add: {
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "moving now" }] }],
            },
          },
        },
      ],
    });
  });

  it("returns stable complete metadata when available", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        values: [{ id: "1", key: "OPS", name: "Operations" }],
      })
      .mockResolvedValueOnce({
        issueTypes: [{ id: "100", name: "Bug", subtask: false, description: "desc" }],
      })
      .mockResolvedValueOnce({
        fields: {
          summary: { name: "Summary", required: true, schema: { type: "string" } },
          customfield_10000: {
            name: "Customer",
            required: false,
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
            allowedValues: [{ value: "A" }, { value: "B" }],
          },
        },
      });
    const service = createJiraService({
      request,
      getSiteUrl: () => "https://example.atlassian.net",
    } as never);

    const payload = await service.getCreateMetadata({ projectKey: "OPS", issueType: "Bug" });
    expect(payload.bestEffort).toBe(true);
    expect(payload.projects).toHaveLength(1);
    expect(payload.issueTypes).toHaveLength(1);
    expect(payload.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "summary", required: true, schemaType: "string" }),
        expect.objectContaining({
          id: "customfield_10000",
          hasAllowedValues: true,
          allowedValues: ["A", "B"],
        }),
      ]),
    );
  });

  it("returns stable partial metadata under restricted tenants", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        values: [{ id: "1", key: "OPS", name: "Operations" }],
      })
      .mockRejectedValueOnce(new JiraApiError("forbidden", "jira_forbidden", 403))
      .mockRejectedValueOnce(new JiraApiError("forbidden", "jira_forbidden", 403));
    const service = createJiraService({
      request,
      getSiteUrl: () => "https://example.atlassian.net",
    } as never);

    const payload = await service.getCreateMetadata({ projectKey: "OPS", issueType: "Bug" });
    expect(payload.bestEffort).toBe(true);
    expect(payload.issueTypes).toEqual([]);
    expect(payload.fields).toEqual([]);
    expect(payload.warnings.length).toBeGreaterThan(0);
  });
});
