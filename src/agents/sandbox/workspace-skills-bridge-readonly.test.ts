import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import { createSandbox, withTempDir } from "./fs-bridge.test-helpers.js";

describe("workspace skills bridge mount policy", () => {
  it("resolves workspace skill roots as read-only", async () => {
    await withTempDir("openclaw-skills-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".agents", "skills", "demo"), { recursive: true });

      const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
      const mounts = buildSandboxFsMounts(sandbox);
      const resolve = (filePath: string) =>
        resolveSandboxFsPathWithMounts({
          filePath,
          cwd: sandbox.workspaceDir,
          defaultWorkspaceRoot: sandbox.workspaceDir,
          defaultContainerRoot: sandbox.containerWorkdir,
          mounts,
        });

      expect(resolve("normal.txt").writable).toBe(true);
      expect(resolve("skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve(".agents/skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve("/workspace/skills/demo/SKILL.md").writable).toBe(false);
    });
  });
});
