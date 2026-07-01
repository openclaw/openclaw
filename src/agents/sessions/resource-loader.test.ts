// Resource loader tests cover compatibility wiring for SDK prompt transform
// aliases and the loadProjectContextFiles workspace-boundary walk.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader, loadProjectContextFiles } from "./resource-loader.js";

describe("loadProjectContextFiles", () => {
  it("walks ancestor directories from cwd up to workspaceDir boundary", () => {
    // Directory layout:
    //   tmp/outside/AGENTS.md     ← must NOT be loaded (outside boundary)
    //   tmp/workspace/AGENTS.md   ← workspace root (boundary)
    //   tmp/workspace/project/    ← intermediate ancestor
    //   tmp/workspace/project/task/AGENTS.md  ← cwd
    const root = mkdtempSync(join(tmpdir(), "openclaw-context-boundary-"));
    try {
      const workspaceDir = join(root, "workspace");
      const projectDir = join(workspaceDir, "project");
      const cwd = join(projectDir, "task");
      const agentDir = join(root, "agent");
      const outsideDir = join(root, "outside");

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(join(workspaceDir, "AGENTS.md"), "# workspace root", "utf-8");
      writeFileSync(join(cwd, "AGENTS.md"), "# task cwd", "utf-8");
      writeFileSync(join(outsideDir, "AGENTS.md"), "# outside", "utf-8");

      const result = loadProjectContextFiles({
        cwd,
        agentDir,
        workspaceDir,
      });

      // Should include workspace-root and task-level context files
      expect(result.length).toBeGreaterThanOrEqual(2);

      const paths = result.map((f) => resolve(f.path));

      // Task cwd AGENTS.md loaded
      expect(paths).toContain(resolve(join(cwd, "AGENTS.md")));

      // Workspace root AGENTS.md loaded (walked up within boundary)
      expect(paths).toContain(resolve(join(workspaceDir, "AGENTS.md")));

      // Outside AGENTS.md must NOT be loaded (beyond workspace boundary)
      expect(paths).not.toContain(resolve(join(outsideDir, "AGENTS.md")));

      // Ordering: workspace-root ancestor comes before task cwd (ancestors prepended)
      const workspaceIdx = paths.indexOf(resolve(join(workspaceDir, "AGENTS.md")));
      const taskIdx = paths.indexOf(resolve(join(cwd, "AGENTS.md")));
      expect(workspaceIdx).toBeLessThan(taskIdx);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("excludes parent directories above the workspace boundary", () => {
    // Directory layout:
    //   tmp/AGENTS.md              ← actual ANCESTOR above workspace, must NOT be loaded
    //   tmp/workspace/AGENTS.md    ← workspace root (boundary)
    //   tmp/workspace/task/        ← cwd (no AGENTS.md here)
    const root = mkdtempSync(join(tmpdir(), "openclaw-boundary-exclusion-"));
    try {
      const workspaceDir = join(root, "workspace");
      const cwd = join(workspaceDir, "task");
      const agentDir = join(root, "agent");

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });

      // Hostile AGENTS.md in the actual ancestor above the workspace
      writeFileSync(join(root, "AGENTS.md"), "# hostile ancestor", "utf-8");
      writeFileSync(join(workspaceDir, "AGENTS.md"), "# trusted workspace", "utf-8");

      const result = loadProjectContextFiles({
        cwd,
        agentDir,
        workspaceDir,
      });

      const paths = result.map((f) => resolve(f.path));

      // Workspace AGENTS.md loaded
      expect(paths).toContain(resolve(join(workspaceDir, "AGENTS.md")));

      // Hostile ancestor (above workspace boundary) must NOT be loaded
      expect(paths).not.toContain(resolve(join(root, "AGENTS.md")));

      // Agent dir context file also loaded (if present)
      // (agentDir is empty in this test so no extra file)
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("stops at cwd when workspaceDir is not provided (backward-compatible)", () => {
    // Without workspaceDir, boundary falls back to cwd.
    // Ancestors above cwd are NOT walked — same as the pre-existing PR
    // behavior for callers that don't pass workspaceDir.
    const root = mkdtempSync(join(tmpdir(), "openclaw-no-workspace-"));
    try {
      const parentDir = join(root, "parent");
      const cwd = join(root, "project");
      const agentDir = join(root, "agent");

      mkdirSync(parentDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });

      writeFileSync(join(parentDir, "AGENTS.md"), "# parent", "utf-8");
      writeFileSync(join(cwd, "AGENTS.md"), "# cwd", "utf-8");

      const result = loadProjectContextFiles({
        cwd,
        agentDir,
        // workspaceDir intentionally omitted
      });

      const paths = result.map((f) => resolve(f.path));

      // cwd AGENTS.md loaded
      expect(paths).toContain(resolve(join(cwd, "AGENTS.md")));

      // Parent AGENTS.md NOT loaded (boundary at cwd when no workspaceDir)
      expect(paths).not.toContain(resolve(join(parentDir, "AGENTS.md")));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("works correctly when cwd is the same as workspaceDir", () => {
    // When cwd === workspaceDir, the boundary is the same directory.
    const root = mkdtempSync(join(tmpdir(), "openclaw-cwd-is-workspace-"));
    try {
      const cwd = join(root, "workspace");
      const agentDir = join(root, "agent");
      const outsideDir = join(root, "outside");

      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(join(cwd, "AGENTS.md"), "# workspace", "utf-8");
      writeFileSync(join(outsideDir, "AGENTS.md"), "# outside", "utf-8");

      const result = loadProjectContextFiles({
        cwd,
        agentDir,
        workspaceDir: cwd, // explicitly same as cwd
      });

      const paths = result.map((f) => resolve(f.path));

      // Workspace AGENTS.md loaded
      expect(paths).toContain(resolve(join(cwd, "AGENTS.md")));

      // Outside AGENTS.md NOT loaded
      expect(paths).not.toContain(resolve(join(outsideDir, "AGENTS.md")));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("loads context files from intermediate ancestors within the workspace", () => {
    // Deep nesting: cwd 3 levels below workspace root.
    // All ancestor AGENTS.md within workspace should be loaded.
    const root = mkdtempSync(join(tmpdir(), "openclaw-deep-nesting-"));
    try {
      const workspaceDir = join(root, "ws");
      const l1 = join(workspaceDir, "l1");
      const l2 = join(l1, "l2");
      const cwd = join(l2, "cwd");
      const agentDir = join(root, "agent");

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(l1, { recursive: true });
      mkdirSync(l2, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });

      writeFileSync(join(workspaceDir, "AGENTS.md"), "ws", "utf-8");
      writeFileSync(join(l1, "AGENTS.md"), "l1", "utf-8");
      // l2 has no AGENTS.md
      writeFileSync(join(cwd, "AGENTS.md"), "cwd", "utf-8");

      const result = loadProjectContextFiles({
        cwd,
        agentDir,
        workspaceDir,
      });

      const paths = result.map((f) => resolve(f.path));

      expect(paths).toContain(resolve(join(workspaceDir, "AGENTS.md")));
      expect(paths).toContain(resolve(join(l1, "AGENTS.md")));
      expect(paths).toContain(resolve(join(cwd, "AGENTS.md")));

      // Ancestor ordering: deeper ancestors before shallower, but all ancestors
      // before task cwd since ancestors are unshifted onto the array.
      const wsIdx = paths.indexOf(resolve(join(workspaceDir, "AGENTS.md")));
      const l1Idx = paths.indexOf(resolve(join(l1, "AGENTS.md")));
      const cwdIdx = paths.indexOf(resolve(join(cwd, "AGENTS.md")));

      // Workspace root is closest ancestor (last unshifted → index 0)
      // l1 is next (unshifted after cwd but before ws)
      // Task cwd is after all ancestors (pushed last)
      expect(wsIdx).toBeLessThan(cwdIdx);
      expect(l1Idx).toBeLessThan(cwdIdx);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fail-closed when cwd is not inside the workspace boundary", () => {
    // When cwd resolves to a path outside workspaceDir, the function must
    // NOT walk ancestors — a relative, symlink-mismatched, or non-descendant
    // cwd could otherwise bypass the equality stop condition and load context
    // files from parent directories outside the trusted workspace.
    const root = mkdtempSync(join(tmpdir(), "openclaw-fail-closed-"));
    try {
      const workspaceDir = join(root, "workspace");
      const cwdOutside = join(root, "other");
      const agentDir = join(root, "agent");

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(cwdOutside, { recursive: true });
      mkdirSync(agentDir, { recursive: true });

      writeFileSync(join(root, "AGENTS.md"), "# hostile root", "utf-8");
      writeFileSync(join(workspaceDir, "AGENTS.md"), "# workspace", "utf-8");
      writeFileSync(join(cwdOutside, "AGENTS.md"), "# other", "utf-8");

      const result = loadProjectContextFiles({
        cwd: cwdOutside,
        agentDir,
        workspaceDir,
      });

      // cwd is outside the workspace boundary → no ancestor context files loaded
      // (agentDir has no AGENTS.md in this test)
      expect(result.length).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves all input paths before the boundary comparison", () => {
    // All paths passed to loadProjectContextFiles must be resolved before
    // the containment and equality checks — this prevents a relative or
    // non-canonical cwd from bypassing the workspace boundary.
    //
    // Note: absolute paths are returned by resolve() as-is, so the real
    // guard is the containment check in the fail-closed test above.
    // This test verifies the general path-resolution contract.
    const root = mkdtempSync(join(tmpdir(), "openclaw-path-resolution-"));
    try {
      const workspaceDir = join(root, "workspace");
      const cwd = join(workspaceDir, "task");
      const agentDir = join(root, "agent");

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });

      writeFileSync(join(root, "AGENTS.md"), "# hostile root", "utf-8");
      writeFileSync(join(workspaceDir, "AGENTS.md"), "# workspace", "utf-8");
      writeFileSync(join(cwd, "AGENTS.md"), "# task", "utf-8");

      const result = loadProjectContextFiles({
        cwd,
        agentDir,
        workspaceDir,
      });

      const paths = result.map((f) => resolve(f.path));

      // Task cwd loaded
      expect(paths).toContain(resolve(join(cwd, "AGENTS.md")));

      // Workspace root loaded
      expect(paths).toContain(resolve(join(workspaceDir, "AGENTS.md")));

      // Hostile root AGENTS.md NOT loaded (above workspace boundary)
      expect(paths).not.toContain(resolve(join(root, "AGENTS.md")));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe(".DefaultResourceLoader", () => {
  it("keeps deprecated SDK prompt override aliases wired to prompt transforms", async () => {
    // These aliases are deprecated but shipped SDK surface, so they still map
    // through the same transform path as the current options.
    const root = mkdtempSync(join(tmpdir(), "openclaw-resource-loader-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "base",
        appendSystemPrompt: ["tail"],
        systemPromptOverride: (base) => `${base ?? ""} legacy`,
        appendSystemPromptOverride: (base) => [...base, "legacy"],
      });

      await loader.reload();

      expect(loader.getSystemPrompt()).toBe("base legacy");
      expect(loader.getAppendSystemPrompt()).toEqual(["tail", "legacy"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("passes workspaceDir through to context file loading", async () => {
    // Verify DefaultResourceLoader threads workspaceDir into
    // loadProjectContextFiles so the boundary is applied.
    const root = mkdtempSync(join(tmpdir(), "openclaw-drl-workspace-"));
    try {
      const workspaceDir = join(root, "ws");
      const cwd = join(workspaceDir, "task");
      const agentDir = join(root, "agent");
      const outsideDir = join(root, "outside");

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(join(workspaceDir, "AGENTS.md"), "# ws", "utf-8");
      writeFileSync(join(cwd, "AGENTS.md"), "# cwd", "utf-8");
      writeFileSync(join(outsideDir, "AGENTS.md"), "# outside", "utf-8");

      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        workspaceDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });

      await loader.reload();
      const { agentsFiles } = loader.getAgentsFiles();
      const paths = agentsFiles.map((f) => resolve(f.path));

      // Workspace + cwd context files loaded
      expect(paths).toContain(resolve(join(workspaceDir, "AGENTS.md")));
      expect(paths).toContain(resolve(join(cwd, "AGENTS.md")));

      // Outside NOT loaded
      expect(paths).not.toContain(resolve(join(outsideDir, "AGENTS.md")));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
