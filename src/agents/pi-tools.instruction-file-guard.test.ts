import { describe, expect, it, vi } from "vitest";
import {
  isProtectedInstructionFile,
  wrapToolInstructionFileGuard,
} from "./pi-tools.instruction-file-guard.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function createMockTool(name = "write"): AnyAgentTool {
  return {
    name,
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  } as unknown as AnyAgentTool;
}

describe("isProtectedInstructionFile", () => {
  it("matches SOUL.md", () => {
    expect(isProtectedInstructionFile("SOUL.md")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isProtectedInstructionFile("soul.md")).toBe(true);
    expect(isProtectedInstructionFile("Soul.MD")).toBe(true);
    expect(isProtectedInstructionFile("CLAUDE.MD")).toBe(true);
  });

  it("matches nested paths", () => {
    expect(isProtectedInstructionFile("/workspace/agents/pj/SOUL.md")).toBe(true);
    expect(isProtectedInstructionFile("/home/ka/.openclaw/agents/coach/IDENTITY.md")).toBe(true);
  });

  it("does not match non-protected files", () => {
    expect(isProtectedInstructionFile("memory/2026-04-14.md")).toBe(false);
    expect(isProtectedInstructionFile("README.md")).toBe(false);
    expect(isProtectedInstructionFile("notes.md")).toBe(false);
    expect(isProtectedInstructionFile("/workspace/src/soul.ts")).toBe(false);
  });

  it("matches all protected basenames", () => {
    for (const name of [
      "SOUL.md",
      "MEMORY.md",
      "IDENTITY.md",
      "CLAUDE.md",
      "TOOLS.md",
      "BOOT.md",
      "TASKS.md",
    ]) {
      expect(isProtectedInstructionFile(name)).toBe(true);
    }
  });

  it("normalizes win32 trailing-dot aliases", () => {
    expect(isProtectedInstructionFile("SOUL.md.")).toBe(true);
    expect(isProtectedInstructionFile("CLAUDE.md..")).toBe(true);
    expect(isProtectedInstructionFile("MEMORY.md. ")).toBe(true);
  });

  it("does not false-positive on similar names with trailing dots", () => {
    expect(isProtectedInstructionFile("README.md.")).toBe(false);
    expect(isProtectedInstructionFile("notes.md.")).toBe(false);
  });

  it("normalizes @-prefix bypass (resolvePathFromInput strips @)", () => {
    expect(isProtectedInstructionFile("@SOUL.md")).toBe(true);
    expect(isProtectedInstructionFile("@CLAUDE.md")).toBe(true);
    expect(isProtectedInstructionFile("@IDENTITY.md")).toBe(true);
    expect(isProtectedInstructionFile("@README.md")).toBe(false);
  });

  it("normalizes unicode space variants", () => {
    expect(isProtectedInstructionFile("SOUL\u00A0.md")).toBe(true);
    expect(isProtectedInstructionFile("CLAUDE\u200B.md")).toBe(true);
  });
});

describe("wrapToolInstructionFileGuard", () => {
  it("blocks write to SOUL.md", async () => {
    const tool = createMockTool("write");
    const guarded = wrapToolInstructionFileGuard(tool);
    await expect(
      guarded.execute("tc1", { path: "/workspace/SOUL.md", content: "hacked" }),
    ).rejects.toThrow(/Write to instruction file "SOUL.md" is blocked/);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("blocks edit to CLAUDE.md", async () => {
    const tool = createMockTool("edit");
    const guarded = wrapToolInstructionFileGuard(tool);
    await expect(
      guarded.execute("tc2", { path: "CLAUDE.md", edits: [{ old: "a", new: "b" }] }),
    ).rejects.toThrow(/Write to instruction file "CLAUDE.md" is blocked/);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("allows write to non-protected file", async () => {
    const tool = createMockTool("write");
    const guarded = wrapToolInstructionFileGuard(tool);
    await guarded.execute("tc3", { path: "memory/2026-04-14.md", content: "notes" });
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("allows write when path is missing", async () => {
    const tool = createMockTool("write");
    const guarded = wrapToolInstructionFileGuard(tool);
    await guarded.execute("tc4", { content: "no path" });
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("case-insensitive matching blocks soul.md", async () => {
    const tool = createMockTool("write");
    const guarded = wrapToolInstructionFileGuard(tool);
    await expect(guarded.execute("tc5", { path: "/tmp/soul.md", content: "x" })).rejects.toThrow(
      /Write to instruction file "soul.md" is blocked/,
    );
  });

  it("passes through tool without execute", () => {
    const tool = {
      name: "noop",
      description: "no exec",
      inputSchema: {},
    } as unknown as AnyAgentTool;
    const guarded = wrapToolInstructionFileGuard(tool);
    expect(guarded.execute).toBeUndefined();
  });
});
