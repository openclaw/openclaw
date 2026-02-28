import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { discoverAgentsMd, formatAgentsMdPreamble } from "./agents-md-discovery.js";

describe("discoverAgentsMd", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempWorkspace("agents-md-discovery-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds AGENTS.md in a parent directory", async () => {
    const sub = path.join(tmpDir, "a", "b");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "a", "AGENTS.md"), "agent rules for a");
    const filePath = path.join(sub, "file.txt");

    const seen = new Set<string>();
    const entries = await discoverAgentsMd(filePath, tmpDir, seen);

    expect(entries).toHaveLength(1);
    expect(entries[0].dir).toBe(path.join(tmpDir, "a"));
    expect(entries[0].content).toBe("agent rules for a");
  });

  it("finds multiple AGENTS.md files sorted root-to-leaf", async () => {
    const deep = path.join(tmpDir, "a", "b", "c");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "a", "AGENTS.md"), "root-ish rules");
    await fs.writeFile(path.join(tmpDir, "a", "b", "c", "AGENTS.md"), "leaf rules");
    const filePath = path.join(deep, "file.txt");

    const seen = new Set<string>();
    const entries = await discoverAgentsMd(filePath, tmpDir, seen);

    expect(entries).toHaveLength(2);
    expect(entries[0].dir).toBe(path.join(tmpDir, "a"));
    expect(entries[1].dir).toBe(path.join(tmpDir, "a", "b", "c"));
  });

  it("skips the workspace root directory", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "workspace root agents");
    const sub = path.join(tmpDir, "sub");
    await fs.mkdir(sub, { recursive: true });
    const filePath = path.join(sub, "file.txt");

    const seen = new Set<string>();
    const entries = await discoverAgentsMd(filePath, tmpDir, seen);

    expect(entries).toHaveLength(0);
  });

  it("does not revisit already-seen directories", async () => {
    const sub = path.join(tmpDir, "a", "b");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "a", "AGENTS.md"), "rules");

    const seen = new Set<string>();

    // First read discovers the AGENTS.md.
    const first = await discoverAgentsMd(path.join(sub, "one.txt"), tmpDir, seen);
    expect(first).toHaveLength(1);

    // Second read in same subtree returns nothing (already seen).
    const second = await discoverAgentsMd(path.join(sub, "two.txt"), tmpDir, seen);
    expect(second).toHaveLength(0);
  });

  it("returns empty when no AGENTS.md exists", async () => {
    const sub = path.join(tmpDir, "empty", "dir");
    await fs.mkdir(sub, { recursive: true });

    const seen = new Set<string>();
    const entries = await discoverAgentsMd(path.join(sub, "file.txt"), tmpDir, seen);

    expect(entries).toHaveLength(0);
  });

  it("skips empty AGENTS.md files", async () => {
    const sub = path.join(tmpDir, "a");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, "AGENTS.md"), "   \n  ");

    const seen = new Set<string>();
    const entries = await discoverAgentsMd(path.join(sub, "file.txt"), tmpDir, seen);

    expect(entries).toHaveLength(0);
  });
});

describe("formatAgentsMdPreamble", () => {
  it("returns empty string for no entries", () => {
    expect(formatAgentsMdPreamble([])).toBe("");
  });

  it("formats a single entry", () => {
    const result = formatAgentsMdPreamble([{ dir: "/a/b", content: "hello" }]);
    expect(result).toContain("--- AGENTS.md (from /a/b/) ---");
    expect(result).toContain("hello");
    expect(result).toContain("--- end AGENTS.md ---");
  });

  it("formats multiple entries with double newline separator", () => {
    const result = formatAgentsMdPreamble([
      { dir: "/a", content: "outer" },
      { dir: "/a/b", content: "inner" },
    ]);
    const parts = result.split("\n\n");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(result.indexOf("outer")).toBeLessThan(result.indexOf("inner"));
  });
});
