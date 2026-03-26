import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readBuildRunArtifact,
  resolveBuildRunRoot,
  slugifyBuildRunWorkspace,
  writeBuildRunArtifact,
} from "./build-runs.js";
import { discoverWorkspacePolicyFiles } from "./workspace.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("build runs", () => {
  it("uses repo-local artifact roots when workspace is inside a git repo", async () => {
    const repoRoot = await makeTempDir("openclaw-build-runs-repo-");
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .git/modules/main\n", "utf-8");
    const workspaceDir = path.join(repoRoot, "apps", "web");
    await fs.mkdir(workspaceDir, { recursive: true });

    const resolved = resolveBuildRunRoot({
      workspaceDir,
      runId: "run-001",
    });

    expect(resolved.storage).toBe("repo-local");
    expect(resolved.repoRoot).toBe(repoRoot);
    expect(resolved.runDir).toBe(path.join(repoRoot, ".openclaw", "build-runs", "run-001"));
  });

  it("falls back to state-dir build-runs roots outside git repos", async () => {
    const stateDir = await makeTempDir("openclaw-build-runs-state-");
    const workspaceDir = await makeTempDir("openclaw-build-runs-workspace-");

    const resolved = resolveBuildRunRoot({
      workspaceDir,
      runId: "run-002",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
      },
    });

    expect(resolved.storage).toBe("state-dir");
    expect(resolved.workspaceSlug).toBe(slugifyBuildRunWorkspace(workspaceDir));
    expect(resolved.runDir).toBe(
      path.join(stateDir, "build-runs", slugifyBuildRunWorkspace(workspaceDir), "run-002"),
    );
  });

  it("writes and reads schema-backed build artifacts", async () => {
    const repoRoot = await makeTempDir("openclaw-build-runs-write-");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const workspaceDir = path.join(repoRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const written = await writeBuildRunArtifact({
      workspaceDir,
      runId: "run-003",
      artifactName: "acceptance",
      value: {
        goal: "Ship a small dashboard",
        in_scope: ["dashboard"],
        out_of_scope: ["admin"],
        blocking_checks: [
          {
            id: "dashboard-renders",
            description: "dashboard renders",
            kind: "functional",
          },
        ],
        quality_bars: {
          functionality: "required",
        },
      },
    });

    expect(written.path).toBe(
      path.join(repoRoot, ".openclaw", "build-runs", "run-003", "acceptance.json"),
    );

    const readBack = await readBuildRunArtifact({
      workspaceDir,
      runId: "run-003",
      artifactName: "acceptance",
    });

    expect(readBack.goal).toBe("Ship a small dashboard");
    expect(readBack.blocking_checks).toHaveLength(1);
  });

  it("rejects malformed artifact payloads with useful errors", async () => {
    const repoRoot = await makeTempDir("openclaw-build-runs-invalid-");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const workspaceDir = path.join(repoRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    await expect(
      writeBuildRunArtifact({
        workspaceDir,
        runId: "run-004",
        artifactName: "build-report",
        value: {
          round: 1,
          summary: 42,
        },
      }),
    ).rejects.toThrow("Invalid build-report.json");
  });

  it("keeps repo-local build-run artifacts out of workspace policy discovery", async () => {
    const repoRoot = await makeTempDir("openclaw-build-runs-policy-");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, ".openclaw", "build-runs", "run-005"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".openclaw", "build-runs", "run-005", "workflow.md"),
      "build artifact note",
      "utf-8",
    );
    await fs.writeFile(path.join(repoRoot, "AGENTS.md"), "repo guidance", "utf-8");

    const discovered = discoverWorkspacePolicyFiles({
      dir: repoRoot,
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: path.join(repoRoot, "AGENTS.md"),
          content: "repo guidance",
          missing: false,
        },
      ],
    });

    expect(discovered.map((entry) => entry.name)).toEqual(["AGENTS.md"]);
  });
});
