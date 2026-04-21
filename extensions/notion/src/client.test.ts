import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../../../src/test-helpers/http.js";
import { NotionApiClient } from "./client.js";

function createClient() {
  return new NotionApiClient({
    baseUrl: "https://api.notion.com/v1",
    token: "test-token",
  });
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(requestBodyText(init?.body)) as Record<string, unknown>;
}

describe("NotionApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts search parameters in the request body and skips the filter for kind=all", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://api.notion.com/v1/search");
      expect(parseJsonBody(init)).toEqual({
        query: "meeting notes",
        page_size: 10,
        start_cursor: "cursor-1",
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("Notion-Version")).toBe("2026-03-11");
      return jsonResponse({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    await client.search("meeting notes", "all", 10, "cursor-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("queries data sources through the data_sources endpoint with POST pagination fields", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://api.notion.com/v1/data_sources/ds-123/query");
      expect(parseJsonBody(init)).toEqual({
        filter: { property: "Status", select: { equals: "Done" } },
        sorts: [{ property: "Created", direction: "descending" }],
        page_size: 25,
        start_cursor: "cursor-2",
      });
      return jsonResponse({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    await client.queryDataSource(
      "ds-123",
      { property: "Status", select: { equals: "Done" } },
      [{ property: "Created", direction: "descending" }],
      25,
      "cursor-2",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts advanced search query, pagination, filter, and sort in the request body", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://api.notion.com/v1/search");
      expect(parseJsonBody(init)).toEqual({
        query: "project alpha",
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 20,
        start_cursor: "cursor-9",
      });
      return jsonResponse({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    await client.advancedSearch(
      "project alpha",
      { property: "object", value: "page" },
      { direction: "descending", timestamp: "last_edited_time" },
      20,
      "cursor-9",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps create-page parents to Notion request shapes", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(parseJsonBody(init)).toEqual({
        parent: { data_source_id: "ds-123" },
        properties: {
          Name: {
            title: [{ text: { content: "Task" } }],
          },
        },
        children: [{ object: "block", type: "paragraph" }],
      });
      return jsonResponse({ id: "page-123" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    await client.createPage(
      { type: "data_source", id: "ds-123" },
      {
        Name: {
          title: [{ text: { content: "Task" } }],
        },
      },
      [{ object: "block", type: "paragraph" }],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses erase_content and append block children when updating page content", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: requestUrl(input), init });
      if (calls.length === 1) {
        return jsonResponse({ id: "page-123", object: "page" });
      }
      return jsonResponse({ object: "list", results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    const result = await client.updatePage(
      "page-123",
      { Name: { title: [{ text: { content: "Updated" } }] } },
      [{ object: "block", type: "paragraph" }],
      undefined,
      undefined,
      true,
      true,
      false,
    );

    expect(result).toEqual({
      ok: true,
      data: {
        id: "page-123",
        object: "page",
        appended_children: { object: "list", results: [] },
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.notion.com/v1/pages/page-123");
    expect(parseJsonBody(calls[0]?.init)).toEqual({
      properties: { Name: { title: [{ text: { content: "Updated" } }] } },
      erase_content: true,
      in_trash: true,
    });
    expect(calls[1]?.url).toBe("https://api.notion.com/v1/blocks/page-123/children");
    expect(parseJsonBody(calls[1]?.init)).toEqual({
      children: [{ object: "block", type: "paragraph" }],
    });
  });

  it("resolves database URLs to a single child data source when targetType=data_source", async () => {
    const databaseId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const dataSourceId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === `https://api.notion.com/v1/data_sources/${databaseId}`) {
        return new Response("not found", { status: 404 });
      }
      if (url === `https://api.notion.com/v1/databases/${databaseId}`) {
        return jsonResponse({ data_sources: [{ id: dataSourceId, name: "Tasks" }] });
      }
      if (url === `https://api.notion.com/v1/data_sources/${dataSourceId}`) {
        return jsonResponse({ object: "data_source", id: dataSourceId });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    const result = await client.fetchPage(
      "https://www.notion.so/workspace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=view-123",
      "data_source",
    );

    expect(result).toEqual({
      ok: true,
      data: { object: "data_source", id: dataSourceId },
    });
    expect(calls).toEqual([
      `https://api.notion.com/v1/data_sources/${databaseId}`,
      `https://api.notion.com/v1/databases/${databaseId}`,
      `https://api.notion.com/v1/data_sources/${dataSourceId}`,
    ]);
  });

  it("fails fetchPage when includeBlocks is requested and block retrieval fails", async () => {
    const pageId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === `https://api.notion.com/v1/pages/${pageId}`) {
        return jsonResponse({ id: pageId, object: "page" });
      }
      if (url === `https://api.notion.com/v1/blocks/${pageId}/children`) {
        return new Response("forbidden", { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    const result = await client.fetchPage(pageId, "page", true);

    expect(result).toEqual({
      ok: false,
      error:
        "Notion API error: Request to Notion API failed with status: 403 (code: notionhq_client_response_error, status: 403)",
    });
  });

  it("creates discussion replies with discussion_id instead of a parent object", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(parseJsonBody(init)).toEqual({
        rich_text: [{ text: { content: "Reply" } }],
        discussion_id: "discussion-123",
      });
      return jsonResponse({ id: "comment-123" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    await client.createComment({
      richText: [{ text: { content: "Reply" } }],
      discussionId: "discussion-123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges addProperties and renameProperties into the data source properties patch", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://api.notion.com/v1/data_sources/ds-123");
      expect(parseJsonBody(init)).toEqual({
        title: [{ type: "text", text: { content: "Tasks" } }],
        properties: {
          Status: { select: {} },
          Existing: { number: {}, name: "Estimate" },
        },
        parent: { database_id: "db-456" },
        in_trash: true,
        icon: { type: "emoji", emoji: "🔥" },
      });
      return jsonResponse({ id: "ds-123" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    await client.updateDataSource(
      "ds-123",
      "Tasks",
      {
        Status: { select: {} },
        Existing: { number: {} },
      },
      [{ from: "Existing", to: "Estimate" }],
      "db-456",
      true,
      { type: "emoji", emoji: "🔥" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
