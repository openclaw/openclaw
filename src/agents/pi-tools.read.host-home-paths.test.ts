import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lastWriteParams: undefined as Record<string, unknown> | undefined,
  lastEditParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createWriteTool: () => ({
      name: "write",
      description: "test write tool",
      parameters: { type: "object", properties: {} },
      execute: async (_toolCallId: string, params: unknown) => {
        mocks.lastWriteParams =
          params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: { params: mocks.lastWriteParams },
        };
      },
    }),
    createEditTool: () => ({
      name: "edit",
      description: "test edit tool",
      parameters: { type: "object", properties: {} },
      execute: async (_toolCallId: string, params: unknown) => {
        mocks.lastEditParams =
          params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: { params: mocks.lastEditParams },
        };
      },
    }),
  };
});

const { createHostWorkspaceWriteTool, createHostWorkspaceEditTool } =
  await import("./pi-tools.read.js");

describe("host coding tool home-relative path normalization", () => {
  afterEach(() => {
    mocks.lastWriteParams = undefined;
    mocks.lastEditParams = undefined;
    vi.unstubAllEnvs();
  });

  it("expands write paths with OPENCLAW_HOME before delegating to the upstream tool", async () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/ignored");

    const tool = createHostWorkspaceWriteTool("/tmp/workspace");
    await tool.execute(
      "call-1",
      { path: "~/.openclaw/workspace/test.txt", content: "hello" },
      undefined,
    );

    expect(mocks.lastWriteParams?.path).toBe(
      path.resolve("/srv/openclaw-home", ".openclaw", "workspace", "test.txt"),
    );
    expect(mocks.lastWriteParams?.content).toBe("hello");
  });

  it("normalizes file_path aliases for edit and resolves them against OPENCLAW_HOME", async () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/ignored");

    const tool = createHostWorkspaceEditTool("/tmp/workspace");
    await tool.execute(
      "call-1",
      {
        file_path: "~/.openclaw/workspace/test.txt",
        old_string: "before",
        new_string: "after",
      },
      undefined,
    );

    expect(mocks.lastEditParams?.path).toBe(
      path.resolve("/srv/openclaw-home", ".openclaw", "workspace", "test.txt"),
    );
    expect(mocks.lastEditParams?.oldText).toBe("before");
    expect(mocks.lastEditParams?.newText).toBe("after");
  });

  it("leaves relative write paths untouched so the workspace root still applies", async () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");

    const tool = createHostWorkspaceWriteTool("/tmp/workspace");
    await tool.execute("call-1", { path: "notes/todo.txt", content: "hello" }, undefined);

    expect(mocks.lastWriteParams?.path).toBe("notes/todo.txt");
  });
});
