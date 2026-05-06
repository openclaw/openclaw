import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostWorkspaceAppendTool, wrapToolWorkspaceRootGuard } from "./pi-tools.read.js";

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

describe("createHostWorkspaceAppendTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-append-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates file if missing and returns truthful message", async () => {
    const tool = createHostWorkspaceAppendTool(tmpDir);
    const result = await tool.execute("id1", {
      path: "memory/2026-04-30.md",
      content: "hello world",
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("Appended");
    expect(text).toContain("11 bytes");
    expect(text).toContain("memory/2026-04-30.md");
    const written = await fs.readFile(path.join(tmpDir, "memory", "2026-04-30.md"), "utf-8");
    expect(written).toBe("hello world");
  });

  it("appends to existing file", async () => {
    const filePath = path.join(tmpDir, "notes.md");
    await fs.writeFile(filePath, "first line", "utf-8");

    const tool = createHostWorkspaceAppendTool(tmpDir);
    await tool.execute("id2", { path: "notes.md", content: "second line" });
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("first line");
    expect(content).toContain("second line");
  });

  it("returns truthful 'Appended N bytes' message, never 'Wrote'", async () => {
    const tool = createHostWorkspaceAppendTool(tmpDir);
    const result = await tool.execute("id3", { path: "log.md", content: "entry" });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/^Appended/);
    expect(text).not.toContain("Wrote");
  });

  it("respects workspace-root guard when workspaceOnly=true", async () => {
    const tool = wrapToolWorkspaceRootGuard(
      createHostWorkspaceAppendTool(tmpDir, { workspaceOnly: true }),
      tmpDir,
    );
    await expect(
      tool.execute("id4", { path: path.join(tmpDir, "../escape.md"), content: "bad" }),
    ).rejects.toThrow();
  });
});
