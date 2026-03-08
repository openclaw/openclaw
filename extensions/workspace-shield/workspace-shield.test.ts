import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

function createMockApi(workspaceDir: string, config: Record<string, unknown> = {}) {
  const handlers: Record<string, Function> = {};
  return {
    api: {
      config,
      workspaceDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    },
    handlers,
  };
}

describe("workspace-shield plugin", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-shield-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks Write to protected files", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["SOUL.md", "IDENTITY.md"],
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_tool_call({
      toolName: "Write",
      params: { file_path: "SOUL.md", content: "overwritten" },
    });

    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("protected file");
    expect(result.blockReason).toContain("SOUL.md");
  });

  it("blocks Edit to protected files", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["SOUL.md"],
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_tool_call({
      toolName: "Edit",
      params: { file_path: "SOUL.md", old_string: "a", new_string: "b" },
    });

    expect(result.block).toBe(true);
  });

  it("allows Read on protected files by default", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["SOUL.md"],
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_tool_call({
      toolName: "Read",
      params: { path: "SOUL.md" },
    });

    expect(result).toEqual({});
  });

  it("blocks Read when allowReads is false", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["secrets.env"],
      allowReads: false,
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_tool_call({
      toolName: "Read",
      params: { path: "secrets.env" },
    });

    expect(result.block).toBe(true);
  });

  it("allows operations on non-protected files", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["SOUL.md"],
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_tool_call({
      toolName: "Write",
      params: { file_path: "README.md", content: "hello" },
    });

    expect(result).toEqual({});
  });

  it("supports glob patterns", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedPatterns: ["*.env", "secrets/**"],
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const envResult = handlers.before_tool_call({
      toolName: "Write",
      params: { file_path: ".env", content: "SECRET=x" },
    });
    expect(envResult.block).toBe(true);

    const secretResult = handlers.before_tool_call({
      toolName: "Write",
      params: { file_path: "secrets/api-key.txt", content: "sk-..." },
    });
    expect(secretResult.block).toBe(true);

    const safeResult = handlers.before_tool_call({
      toolName: "Write",
      params: { file_path: "notes.md", content: "safe" },
    });
    expect(safeResult).toEqual({});
  });

  it("allows unrelated tools through", async () => {
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["SOUL.md"],
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_tool_call({
      toolName: "exec",
      params: { command: "echo hello" },
    });

    expect(result).toEqual({});
  });

  it("logs violations when logViolations is true", async () => {
    const logPath = path.join(tmpDir, "test-violations.jsonl");
    const { api, handlers } = createMockApi(tmpDir, {
      protectedFiles: ["SOUL.md"],
      violationsPath: logPath,
    });
    const { default: register } = await import("./index.js");
    register(api as any);

    handlers.before_tool_call({
      toolName: "Write",
      params: { file_path: "SOUL.md", content: "bad" },
    });

    expect(fs.existsSync(logPath)).toBe(true);
    const log = fs.readFileSync(logPath, "utf-8").trim();
    const record = JSON.parse(log);
    expect(record.tool).toBe("Write");
    expect(record.file).toBe("SOUL.md");
    expect(record.action).toBe("blocked");
  });

  it("does nothing when no files or patterns are configured", async () => {
    const { api, handlers } = createMockApi(tmpDir, {});
    const { default: register } = await import("./index.js");
    register(api as any);

    // No before_tool_call handler should be registered
    expect(handlers.before_tool_call).toBeUndefined();
  });
});
