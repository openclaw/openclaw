import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestBodyText, requestUrl } from "../../../src/test-helpers/http.js";
import notionPlugin from "./tools.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(requestBodyText(init?.body)) as Record<string, unknown>;
}

function captureRegisteredTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();

  notionPlugin.register({
    pluginConfig: {},
    on() {},
    registerTool(toolFactory: (() => RegisteredTool) | RegisteredTool) {
      const tool = typeof toolFactory === "function" ? toolFactory() : toolFactory;
      tools.set(tool.name, tool);
    },
  } as never);

  return tools;
}

function captureBeforeToolCallHandler() {
  let beforeToolCall:
    | ((event: { toolName: string; params: Record<string, unknown> }) => unknown)
    | undefined;

  notionPlugin.register({
    pluginConfig: { safety: { writeApprovalMode: "per_call" } },
    on(
      eventName: string,
      handler: (event: { toolName: string; params: Record<string, unknown> }) => unknown,
    ) {
      if (eventName === "before_tool_call") {
        beforeToolCall = handler;
      }
    },
    registerTool() {},
  } as never);

  return beforeToolCall;
}

describe("notion tools", () => {
  const originalToken = process.env.NOTION_TOKEN;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.NOTION_TOKEN;
    } else {
      process.env.NOTION_TOKEN = originalToken;
    }
    vi.unstubAllGlobals();
  });

  it("passes parentType through notion_create_comment", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(parseJsonBody(init)).toEqual({
        rich_text: [{ text: { content: "Ship it" } }],
        parent: { page_id: "page-123" },
      });
      return new Response(JSON.stringify({ id: "comment-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const createCommentTool = captureRegisteredTools().get("notion_create_comment");
    expect(createCommentTool).toBeDefined();

    await createCommentTool?.execute("tool-call-1", {
      blockId: "page-123",
      parentType: "page_id",
      richText: [{ text: { content: "Ship it" } }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards notion_fetch block pagination parameters to the client", async () => {
    const pageId = "11111111-1111-1111-1111-111111111111";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === `https://api.notion.com/v1/pages/${pageId}`) {
        return new Response(JSON.stringify({ id: "page-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        url ===
        `https://api.notion.com/v1/blocks/${pageId}/children?start_cursor=cursor-3&page_size=5`
      ) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchTool = captureRegisteredTools().get("notion_fetch");
    expect(fetchTool).toBeDefined();

    await fetchTool?.execute("tool-call-2", {
      target: pageId,
      targetType: "page",
      includeBlocks: true,
      blockPageSize: 5,
      blockCursor: "cursor-3",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires approval for notion comment write tools", () => {
    const beforeToolCall = captureBeforeToolCallHandler();
    expect(beforeToolCall).toBeDefined();

    const createCommentApproval = beforeToolCall?.({
      toolName: "notion_create_comment",
      params: { blockId: "page-123", richText: [] },
    }) as { requireApproval?: { pluginId?: string } } | undefined;

    const updateCommentApproval = beforeToolCall?.({
      toolName: "notion_update_comment",
      params: { commentId: "comment-123", richText: [] },
    }) as { requireApproval?: { pluginId?: string } } | undefined;

    expect(createCommentApproval?.requireApproval?.pluginId).toBe("notion");
    expect(updateCommentApproval?.requireApproval?.pluginId).toBe("notion");
  });
});
