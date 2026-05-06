import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostWorkspaceWriteTool, wrapToolMemoryDayFileWriteGuard } from "./pi-tools.read.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return { ...original };
});

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: () => undefined,
    getOAuthProviders: () => [],
  };
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("wrapToolMemoryDayFileWriteGuard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guard-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeWriteTool() {
    return wrapToolMemoryDayFileWriteGuard(createHostWorkspaceWriteTool(tmpDir));
  }

  it("refuses memory/day-file path without overwrite", async () => {
    const tool = makeWriteTool();
    const result = await tool.execute("id1", {
      path: "memory/2026-04-30.md",
      content: "some content",
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("Refusing to overwrite");
    expect(text).toContain("memory/2026-04-30.md");
    expect(text).toContain("append");
    expect(text).toContain("overwrite:true");
    expect((result.details as Record<string, unknown>)?.refused).toBe(true);
  });

  it("allows memory/day-file path with overwrite:true and emits warning prefix", async () => {
    const filePath = path.join(tmpDir, "memory", "2026-04-30.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "existing content", "utf-8");

    const tool = makeWriteTool();
    const result = await tool.execute("id2", {
      path: "memory/2026-04-30.md",
      content: "new content",
      overwrite: true,
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("WARNING: Overwrote memory/day-file path");
    expect(text).toContain("Previous content lost");
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("new content");
  });

  it("passes through non-matching paths without guard", async () => {
    const tool = makeWriteTool();
    for (const p of ["README.md", "src/foo.ts", "notes.txt"]) {
      const result = await tool.execute("id3", { path: p, content: "hello" });
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      expect(text).not.toContain("Refusing");
      expect(text).not.toContain("WARNING");
    }
  });

  it("accepts custom glob patterns via options", async () => {
    const tool = wrapToolMemoryDayFileWriteGuard(createHostWorkspaceWriteTool(tmpDir), {
      patterns: [/^sovereign\/locked\.md$/],
    });

    const refused = await tool.execute("id4", { path: "sovereign/locked.md", content: "x" });
    const refusedText = refused.content.find((c) => c.type === "text")?.text ?? "";
    expect(refusedText).toContain("Refusing to overwrite");

    // Default memory pattern should NOT be active when custom patterns provided
    const allowed = await tool.execute("id5", {
      path: "memory/2026-04-30.md",
      content: "y",
    });
    const allowedText = allowed.content.find((c) => c.type === "text")?.text ?? "";
    expect(allowedText).not.toContain("Refusing");
  });
});
