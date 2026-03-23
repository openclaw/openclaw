import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Minimal mock read tool that simulates the upstream pi-coding-agent behavior.
 * Throws an error when offset exceeds totalLines, returns paginated text otherwise.
 */
function createMockReadTool(opts: {
  totalLines: number;
  linesPerPage?: number;
  content?: string;
}): AnyAgentTool {
  const totalLines = opts.totalLines;
  const linesPerPage = opts.linesPerPage ?? totalLines;
  const fileLines = (
    opts.content ?? Array.from({ length: totalLines }, (_, i) => `line ${i + 1}`).join("\n")
  ).split("\n");

  return {
    name: "Read",
    label: "Read",
    description: "Read file contents",
    parameters: {},
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const offset = typeof params.offset === "number" ? params.offset : 1;
      const limit = typeof params.limit === "number" ? params.limit : undefined;

      if (offset > totalLines) {
        throw new Error(`Offset ${offset} is out of range. File has ${totalLines} lines.`);
      }
      if (offset < 1) {
        throw new Error(`Offset must be >= 1, got ${offset}`);
      }

      const startIdx = offset - 1;
      const endIdx = limit
        ? Math.min(startIdx + limit, fileLines.length)
        : Math.min(startIdx + linesPerPage, fileLines.length);
      const slice = fileLines.slice(startIdx, endIdx);
      const truncated = endIdx < fileLines.length;

      const result: AgentToolResult<unknown> = {
        content: [{ type: "text", text: slice.join("\n") }],
        details: truncated
          ? {
              truncation: {
                truncated: true,
                outputLines: endIdx - startIdx,
                firstLineExceedsLimit: false,
              },
            }
          : undefined,
      };
      return result;
    },
  } as AnyAgentTool;
}

function getResultText(result: AgentToolResult<unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("tools.read offset out-of-range handling", () => {
  it("returns diagnostic + fallback content when offset exceeds file length", async () => {
    const mockBase = createMockReadTool({ totalLines: 10 });
    const tool = createOpenClawReadTool(mockBase);

    const result = await tool.execute("test-call-1", { path: "test.txt", offset: 200 });
    const text = getResultText(result);

    expect(text).toContain("offset 200 is out of range");
    expect(text).toContain("Showing from line 1");
    // Should include fallback content from line 1
    expect(text).toContain("line 1");
  });

  it("does not abort the run — returns a result object (not throw)", async () => {
    const mockBase = createMockReadTool({ totalLines: 5 });
    const tool = createOpenClawReadTool(mockBase);

    // This should NOT throw
    const result = await tool.execute("test-call-2", { path: "small.txt", offset: 999 });
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it("returns normal content when offset is within range", async () => {
    const mockBase = createMockReadTool({ totalLines: 20 });
    const tool = createOpenClawReadTool(mockBase);

    const result = await tool.execute("test-call-3", { path: "normal.txt", offset: 5 });
    const text = getResultText(result);

    // Should NOT contain the diagnostic note
    expect(text).not.toContain("out of range");
    expect(text).toContain("line 5");
  });

  it("still throws for non-offset errors (e.g. ENOENT)", async () => {
    const tool = createOpenClawReadTool({
      name: "Read",
      label: "Read",
      description: "Read file contents",
      parameters: {},
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    } as AnyAgentTool);

    await expect(tool.execute("test-call-4", { path: "/nonexistent/file.txt" })).rejects.toThrow(
      "ENOENT",
    );
  });

  it("handles offset out of range with explicit limit param", async () => {
    const mockBase = createMockReadTool({ totalLines: 10 });
    const tool = createOpenClawReadTool(mockBase);

    // With explicit limit, should still handle offset errors gracefully
    const result = await tool.execute("test-call-5", {
      path: "test.txt",
      offset: 200,
      limit: 10,
    });
    const text = getResultText(result);

    expect(text).toContain("offset 200 is out of range");
    expect(text).toContain("Showing from line 1");
  });

  it("returns diagnostic-only result when fallback also fails", async () => {
    // Create a tool where ALL reads fail
    const alwaysFailTool = {
      name: "Read",
      label: "Read",
      description: "Read file contents",
      parameters: {},
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" } },
        required: ["path"],
      },
      execute: async (_id: string, args: unknown) => {
        const params = args as Record<string, unknown>;
        const offset = typeof params.offset === "number" ? params.offset : 1;
        if (offset > 1) {
          throw new Error(`Offset ${offset} is out of range.`);
        }
        throw new Error("Permission denied: cannot read file");
      },
    } as AnyAgentTool;

    const tool = createOpenClawReadTool(alwaysFailTool);
    const result = await tool.execute("test-call-6", { path: "locked.txt", offset: 50 });
    const text = getResultText(result);

    expect(text).toContain("out of range");
    expect(text).toContain("Failed to read file");
  });

  it("returns partial content with accurate note when mid-page read fails", async () => {
    // Simulate a file where page 1 succeeds (truncated) but page 2 offset is out of range.
    // We need a mock that explicitly fails on the second page, since a standard 10-line mock
    // would successfully serve both pages.
    const failOnSecondPageTool = {
      name: "Read",
      label: "Read",
      description: "Read file contents",
      parameters: {},
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" } },
        required: ["path"],
      },
      execute: async (_id: string, args: unknown) => {
        const params = args as Record<string, unknown>;
        const offset = typeof params.offset === "number" ? params.offset : 1;
        if (offset > 5) {
          throw new Error(`Offset ${offset} is out of range. File only has 5 visible lines.`);
        }
        return {
          content: [{ type: "text", text: `lines from offset ${offset}` }],
          details: {
            truncation: {
              truncated: true,
              outputLines: 5,
              firstLineExceedsLimit: false,
            },
          },
        };
      },
    } as AnyAgentTool;

    const tool2 = createOpenClawReadTool(failOnSecondPageTool);
    const result = await tool2.execute("test-call-7", { path: "tricky.txt" });
    const text = getResultText(result);

    // Should contain the partial content from first page
    expect(text).toContain("lines from offset 1");
    // Should NOT say "Showing from line 1" (misleading for mid-page failure)
    expect(text).not.toContain("Showing from line 1");
    // Should indicate the remaining range could not be read
    expect(text).toContain("Could not continue reading");
  });

  it("does not swallow unrelated errors that mention 'line' in a different context", async () => {
    // Errors like "port range error" or "Error on line 42 of config" should NOT be
    // misidentified as offset errors.
    const tool = createOpenClawReadTool({
      name: "Read",
      label: "Read",
      description: "Read file contents",
      parameters: {},
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async () => {
        throw new Error("Invalid configuration: port range must be 1024-65535");
      },
    } as AnyAgentTool);

    await expect(tool.execute("test-call-8", { path: "config.txt" })).rejects.toThrow("port range");
  });

  it("re-throws AbortError from fallback read so the session can unwind as aborted", async () => {
    // Simulate: initial read throws offset error (triggering fallback), but the
    // fallback read is aborted (e.g. user cancelled). The AbortError must propagate,
    // not be swallowed as a fake success.
    const abortingTool = {
      name: "Read",
      label: "Read",
      description: "Read file contents",
      parameters: {},
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" } },
        required: ["path"],
      },
      execute: async (_id: string, args: Record<string, unknown>) => {
        const offset = typeof args.offset === "number" ? args.offset : 1;
        if (offset > 1) {
          throw new Error(`Offset ${offset} is out of range.`);
        }
        // Fallback read from offset=1 throws AbortError (simulating user cancel)
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    } as AnyAgentTool;

    const tool = createOpenClawReadTool(abortingTool);
    await expect(
      tool.execute("test-call-abort", { path: "file.txt", offset: 50 }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
