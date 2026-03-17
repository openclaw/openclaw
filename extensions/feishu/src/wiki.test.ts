/**
 * Tests for listNodes pagination in wiki.ts
 *
 * Covers:
 * 1. Single page (has_more: false) — returns all nodes
 * 2. Multi-page pagination — merges all pages
 * 3. Safety limit (>= 100 pages) — stops and warns
 * 4. has_more=true but no page_token — stops and warns
 * 5. Empty result — returns empty nodes array
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Lark from "@larksuiteoapi/node-sdk";

// Import the exported function under test
import { listNodes } from "./wiki.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpaceNodeListResponse = {
  code: number;
  msg?: string;
  data?: {
    items?: Array<{
      node_token?: string;
      obj_token?: string;
      obj_type?: string;
      title?: string;
      has_child?: boolean;
    }>;
    has_more?: boolean;
    page_token?: string;
  };
};

function makeNode(idx: number) {
  return {
    node_token: `token_${idx}`,
    obj_token: `obj_${idx}`,
    obj_type: "docx",
    title: `Node ${idx}`,
    has_child: false,
  };
}

function buildClient(pages: SpaceNodeListResponse[]): Lark.Client {
  let callCount = 0;
  const listMock = vi.fn().mockImplementation(async () => {
    const page = pages[callCount] ?? pages[pages.length - 1];
    callCount++;
    return page;
  });

  return {
    wiki: {
      spaceNode: {
        list: listMock,
      },
    },
  } as unknown as Lark.Client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listNodes – pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Single page (has_more: false)
  // -------------------------------------------------------------------------
  it("returns all nodes when API returns a single page (has_more: false)", async () => {
    const client = buildClient([
      {
        code: 0,
        data: {
          items: [makeNode(1), makeNode(2), makeNode(3)],
          has_more: false,
        },
      },
    ]);

    const result = await listNodes(client, "space_001");

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].node_token).toBe("token_1");
    expect(result.nodes[2].node_token).toBe("token_3");

    // Only one API call should have been made
    const listFn = (client.wiki.spaceNode as { list: ReturnType<typeof vi.fn> }).list;
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(listFn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { space_id: "space_001" },
        params: expect.objectContaining({ page_size: 50 }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 2. Multi-page pagination
  // -------------------------------------------------------------------------
  it("merges all pages when API paginates across multiple pages", async () => {
    const client = buildClient([
      {
        code: 0,
        data: {
          items: [makeNode(1), makeNode(2)],
          has_more: true,
          page_token: "pt_page2",
        },
      },
      {
        code: 0,
        data: {
          items: [makeNode(3), makeNode(4)],
          has_more: false,
        },
      },
    ]);

    const result = await listNodes(client, "space_002");

    expect(result.nodes).toHaveLength(4);
    expect(result.nodes.map((n) => n.node_token)).toEqual([
      "token_1",
      "token_2",
      "token_3",
      "token_4",
    ]);

    const listFn = (client.wiki.spaceNode as { list: ReturnType<typeof vi.fn> }).list;
    expect(listFn).toHaveBeenCalledTimes(2);

    // Second call should carry the page_token
    expect(listFn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: expect.objectContaining({ page_token: "pt_page2" }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 2b. Three-page pagination
  // -------------------------------------------------------------------------
  it("handles three pages of results correctly", async () => {
    const client = buildClient([
      {
        code: 0,
        data: { items: [makeNode(1)], has_more: true, page_token: "pt_2" },
      },
      {
        code: 0,
        data: { items: [makeNode(2)], has_more: true, page_token: "pt_3" },
      },
      {
        code: 0,
        data: { items: [makeNode(3)], has_more: false },
      },
    ]);

    const result = await listNodes(client, "space_003");

    expect(result.nodes).toHaveLength(3);
    const listFn = (client.wiki.spaceNode as { list: ReturnType<typeof vi.fn> }).list;
    expect(listFn).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // 3. Safety limit — stop at 100 pages
  // -------------------------------------------------------------------------
  it("stops at the 100-page safety limit and emits a warning", async () => {
    // Build 101 pages, all with has_more=true + page_token (except beyond limit)
    const pages: SpaceNodeListResponse[] = Array.from({ length: 101 }, (_, i) => ({
      code: 0,
      data: {
        items: [makeNode(i + 1)],
        has_more: true,
        page_token: `pt_${i + 2}`,
      },
    }));

    const client = buildClient(pages);

    const warnSpy = vi.fn();
    const result = await listNodes(client, "space_safety", undefined, { warn: warnSpy });

    // Should stop after 100 pages (not fetch the 101st)
    const listFn = (client.wiki.spaceNode as { list: ReturnType<typeof vi.fn> }).list;
    expect(listFn).toHaveBeenCalledTimes(100);
    expect(result.nodes).toHaveLength(100);

    // Warning should have been emitted
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("pagination limit"),
    );
  });

  // -------------------------------------------------------------------------
  // 4. has_more=true but no page_token — safe abort with warning
  // -------------------------------------------------------------------------
  it("stops and warns when API returns has_more=true but no page_token", async () => {
    const client = buildClient([
      {
        code: 0,
        data: {
          items: [makeNode(1), makeNode(2)],
          has_more: true,
          // intentionally no page_token
        },
      },
    ]);

    const warnSpy = vi.fn();
    const result = await listNodes(client, "space_no_token", undefined, { warn: warnSpy });

    // Should return what we got from the first page
    expect(result.nodes).toHaveLength(2);

    // Should warn about missing page_token
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("page_token"),
    );

    // Only one API call
    const listFn = (client.wiki.spaceNode as { list: ReturnType<typeof vi.fn> }).list;
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Empty result
  // -------------------------------------------------------------------------
  it("returns an empty nodes array when API returns no items", async () => {
    const client = buildClient([
      {
        code: 0,
        data: {
          items: [],
          has_more: false,
        },
      },
    ]);

    const result = await listNodes(client, "space_empty");

    expect(result.nodes).toHaveLength(0);
    expect(result.nodes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5b. items field missing entirely
  // -------------------------------------------------------------------------
  it("handles missing items field gracefully", async () => {
    const client = buildClient([
      {
        code: 0,
        data: {
          has_more: false,
          // items is undefined
        },
      },
    ]);

    const result = await listNodes(client, "space_no_items");

    expect(result.nodes).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. API error — throws
  // -------------------------------------------------------------------------
  it("throws when API returns a non-zero error code", async () => {
    const client = buildClient([
      {
        code: 403001,
        msg: "No wiki access",
      },
    ]);

    await expect(listNodes(client, "space_error")).rejects.toThrow("No wiki access");
  });

  // -------------------------------------------------------------------------
  // 7. parentNodeToken is forwarded to the API
  // -------------------------------------------------------------------------
  it("forwards parentNodeToken to the API call", async () => {
    const client = buildClient([
      {
        code: 0,
        data: { items: [makeNode(1)], has_more: false },
      },
    ]);

    await listNodes(client, "space_parent", "parent_node_abc");

    const listFn = (client.wiki.spaceNode as { list: ReturnType<typeof vi.fn> }).list;
    expect(listFn).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          parent_node_token: "parent_node_abc",
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 8. Falls back to console.warn when no logger provided
  // -------------------------------------------------------------------------
  it("uses console.warn when no logger is provided and missing page_token", async () => {
    const client = buildClient([
      {
        code: 0,
        data: { items: [makeNode(1)], has_more: true /* no page_token */ },
      },
    ]);

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await listNodes(client, "space_console_warn");
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("page_token"));
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
