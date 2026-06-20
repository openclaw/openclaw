import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("re-applies app exclusions + .app.md swap AFTER hooks (codex #82 P2)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-app-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.app.md"), "LEAN AGENTS", "utf8");
    // A bootstrap hook (cf. bootstrap-extra-files) that injects an excluded file (TOOLS.md)
    // and re-adds the full canonical AGENTS.md after app shaping would otherwise run.
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles.filter((f) => f.name !== "AGENTS.md"),
        {
          name: "AGENTS.md",
          path: path.join(workspaceDir, "AGENTS.md"),
          content: "FULL AGENTS",
          missing: false,
        },
        {
          name: "TOOLS.md",
          path: path.join(workspaceDir, "TOOLS.md"),
          content: "tools",
          missing: false,
        },
      ] as unknown as WorkspaceBootstrapFile[];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:life:app:havaya:user_p2:conv1",
    });
    const byName = Object.fromEntries(files.map((f) => [f.name, f.content]));
    // Excluded file re-injected by the hook is removed for the app session:
    expect(files.some((f) => f.name === "TOOLS.md")).toBe(false);
    // Hook-injected full AGENTS.md is swapped to the lean .app.md variant:
    expect(byName["AGENTS.md"]).toBe("LEAN AGENTS");
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });
});
