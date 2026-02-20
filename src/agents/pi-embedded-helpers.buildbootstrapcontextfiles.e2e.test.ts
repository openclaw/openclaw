import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
import {
  buildBootstrapContextFiles,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(buildBootstrapContextFiles(files).files).toEqual([
      {
        path: "/tmp/AGENTS.md",
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });
  it("skips empty or whitespace-only content", () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(buildBootstrapContextFiles(files).files).toEqual([]);
  });
  it("truncates large bootstrap content", () => {
    const head = `HEAD-${"a".repeat(600)}`;
    const tail = `${"b".repeat(300)}-TAIL`;
    const long = `${head}${tail}`;
    const files = [makeFile({ name: "TOOLS.md", content: long })];
    const warnings: string[] = [];
    const maxChars = 200;
    const expectedTailChars = Math.floor(maxChars * 0.2);
    const { files: resultFiles, truncations } = buildBootstrapContextFiles(files, {
      maxChars,
      warn: (message) => warnings.push(message),
    });
    const [result] = resultFiles;
    expect(result?.content).toContain("[...truncated, read TOOLS.md for full content...]");
    expect(result?.content.length).toBeLessThan(long.length);
    expect(result?.content.startsWith(long.slice(0, 120))).toBe(true);
    expect(result?.content.endsWith(long.slice(-expectedTailChars))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TOOLS.md");
    expect(warnings[0]).toContain("limit 200");
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toEqual({
      name: "TOOLS.md",
      originalChars: long.length,
      budgetChars: 200,
    });
  });
  it("keeps content under the default limit", () => {
    const long = "a".repeat(DEFAULT_BOOTSTRAP_MAX_CHARS - 10);
    const files = [makeFile({ content: long })];
    const { files: resultFiles } = buildBootstrapContextFiles(files);
    expect(resultFiles[0]?.content).toBe(long);
    expect(resultFiles[0]?.content).not.toContain(
      "[...truncated, read AGENTS.md for full content...]",
    );
  });

  it("keeps total injected bootstrap characters under the new default total cap", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(10_000) }),
      makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(10_000) }),
      makeFile({ name: "USER.md", path: "/tmp/USER.md", content: "c".repeat(10_000) }),
    ];
    const { files: resultFiles } = buildBootstrapContextFiles(files);
    const totalChars = resultFiles.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
    expect(resultFiles).toHaveLength(3);
    expect(resultFiles[2]?.content).toBe("c".repeat(10_000));
  });

  it("caps total injected bootstrap characters when totalMaxChars is configured", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(10_000) }),
      makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(10_000) }),
      makeFile({ name: "USER.md", path: "/tmp/USER.md", content: "c".repeat(10_000) }),
    ];
    const { files: resultFiles } = buildBootstrapContextFiles(files, { totalMaxChars: 24_000 });
    const totalChars = resultFiles.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(24_000);
    expect(resultFiles).toHaveLength(3);
    expect(resultFiles[2]?.content).toContain("[...truncated, read USER.md for full content...]");
  });

  it("enforces strict total cap even when truncation markers are present", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(1_000) }),
      makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(1_000) }),
    ];
    const { files: resultFiles } = buildBootstrapContextFiles(files, {
      maxChars: 100,
      totalMaxChars: 150,
    });
    const totalChars = resultFiles.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(150);
  });

  it("skips bootstrap injection when remaining total budget is too small", () => {
    const files = [makeFile({ name: "AGENTS.md", content: "a".repeat(1_000) })];
    const { files: resultFiles } = buildBootstrapContextFiles(files, {
      maxChars: 200,
      totalMaxChars: 40,
    });
    expect(resultFiles).toEqual([]);
  });

  it("keeps missing markers under small total budgets", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    const { files: resultFiles } = buildBootstrapContextFiles(files, {
      totalMaxChars: 20,
    });
    expect(resultFiles).toHaveLength(1);
    expect(resultFiles[0]?.content.length).toBeLessThanOrEqual(20);
    expect(resultFiles[0]?.content.startsWith("[MISSING]")).toBe(true);
  });

  it("returns empty truncations when no files are truncated", () => {
    const files = [makeFile({ name: "AGENTS.md", content: "short content" })];
    const { truncations } = buildBootstrapContextFiles(files);
    expect(truncations).toEqual([]);
  });

  it("returns truncation info for files squeezed by total budget", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(10_000) }),
      makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(10_000) }),
      makeFile({ name: "USER.md", path: "/tmp/USER.md", content: "c".repeat(10_000) }),
    ];
    const { truncations } = buildBootstrapContextFiles(files, { totalMaxChars: 24_000 });
    expect(truncations.length).toBeGreaterThanOrEqual(1);
    expect(truncations.some((t) => t.name === "USER.md")).toBe(true);
  });

  it("reports skipped files in truncations array with 0 budgetChars", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(100) }),
      makeFile({ name: "TOOLS.md", content: "b".repeat(100) }),
    ];
    const { truncations } = buildBootstrapContextFiles(files, { totalMaxChars: 70 });

    const agentsTrunc = truncations.find((t) => t.name === "AGENTS.md");
    expect(agentsTrunc).toBeDefined();
    expect(agentsTrunc?.budgetChars).toBeGreaterThan(0);

    const skippedTrunc = truncations.find((t) => t.name === "TOOLS.md");
    expect(skippedTrunc).toBeDefined();
    expect(skippedTrunc?.budgetChars).toBe(0);
    expect(skippedTrunc?.originalChars).toBe(100);
  });
});

describe("resolveBootstrapMaxChars", () => {
  it("returns default when unset", () => {
    expect(resolveBootstrapMaxChars()).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
  it("uses configured value when valid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: 12345 } },
    } as OpenClawConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(12345);
  });
  it("falls back when invalid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: -1 } },
    } as OpenClawConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
});

describe("resolveBootstrapTotalMaxChars", () => {
  it("returns default when unset", () => {
    expect(resolveBootstrapTotalMaxChars()).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });
  it("uses configured value when valid", () => {
    const cfg = {
      agents: { defaults: { bootstrapTotalMaxChars: 12345 } },
    } as OpenClawConfig;
    expect(resolveBootstrapTotalMaxChars(cfg)).toBe(12345);
  });
  it("falls back when invalid", () => {
    const cfg = {
      agents: { defaults: { bootstrapTotalMaxChars: -1 } },
    } as OpenClawConfig;
    expect(resolveBootstrapTotalMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });
});
