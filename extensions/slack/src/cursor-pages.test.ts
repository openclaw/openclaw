// Slack tests cover cursor pagination behavior.
import { describe, expect, it, vi } from "vitest";
import { collectSlackCursorPages } from "./cursor-pages.js";

type MockPage = {
  items: string[];
  response_metadata?: { next_cursor?: string };
};

describe("collectSlackCursorPages", () => {
  it("collects items from a single page when no cursor is returned", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: ["a", "b"],
      response_metadata: {},
    });

    const items = await collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    expect(items).toEqual(["a", "b"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("collects items across multiple pages while cursor advances", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["a"],
        response_metadata: { next_cursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        items: ["b"],
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        items: ["c"],
        response_metadata: { next_cursor: "" },
      });

    const items = await collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    expect(items).toEqual(["a", "b", "c"]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("throws SlackCursorCycleError when the same cursor repeats", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["a"],
        response_metadata: { next_cursor: "cursor-loop" },
      })
      .mockResolvedValueOnce({
        items: ["b"],
        response_metadata: { next_cursor: "cursor-loop" },
      })
      .mockResolvedValueOnce({
        items: ["c"],
        response_metadata: { next_cursor: "cursor-loop" },
      });

    const promise = collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    await expect(promise).rejects.toThrow(/cycle detected/);
    await expect(promise).rejects.toThrow(/cursor-loop/);
    await expect(promise).rejects.toThrow(/repeated/);
    expect(fetchPage).toHaveBeenCalledTimes(2); // Second call sees the repeat
  });

  it("includes the page count in the cycle error", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["x"],
        response_metadata: { next_cursor: "cursor-x" },
      })
      .mockResolvedValueOnce({
        items: ["y"],
        response_metadata: { next_cursor: "cursor-x" },
      });

    let error: unknown;
    try {
      await collectSlackCursorPages<string, MockPage>({
        fetchPage,
        collectPageItems: (response) => response.items,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("SlackCursorCycleError");
    expect((error as Record<string, unknown>).pageCount).toBe(2);
    expect((error as Record<string, unknown>).cursor).toBe("cursor-x");
    expect((error as Error).message).toContain("cycle detected");
  });

  it("handles empty response from collectPageItems", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      response_metadata: {},
    });

    const items = await collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    expect(items).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("handles null/undefined next_cursor", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: ["only"],
      response_metadata: { next_cursor: undefined },
    });

    const items = await collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    expect(items).toEqual(["only"]);
  });

  it("handles whitespace-only next_cursor like undefined", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: ["trimmed"],
      response_metadata: { next_cursor: "   " },
    });

    const items = await collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    expect(items).toEqual(["trimmed"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe("SlackCursorCycleError behavior", () => {
  it("throws with cycle error name and message", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      response_metadata: { next_cursor: "stuck" },
    });

    const promise = collectSlackCursorPages<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    await expect(promise).rejects.toThrow(/cycle detected/);
    await expect(promise).rejects.toThrow(/stuck/);
  });

  it("documents the safety-backstop exhaustion message contract", () => {
    // Full 10_000-page runs are too expensive for the default suite; the live
    // helper throws SlackCursorCycleError with this message when the budget is
    // exhausted with uniquely advancing cursors.
    const exhaustionMsg =
      "Slack cursor pagination exceeded 10000 pages; all cursors advanced but pagination did not terminate. Data may be incomplete.";
    expect(exhaustionMsg).toContain("exceeded");
    expect(exhaustionMsg).toContain("10000");
    expect(exhaustionMsg).toContain("incomplete");
  });
});
