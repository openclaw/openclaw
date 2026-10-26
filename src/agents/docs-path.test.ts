import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawReferencePaths } from "./docs-path.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makePackageRoot(hasDocs = false, git = false): Promise<string> {
  const root = tempDirs.make("openclaw-reference-");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
  if (hasDocs) {
    await writeDocsJson(root);
  }
  if (git) {
    await fs.mkdir(path.join(root, ".git"));
  }
  return root;
}

async function writeDocsJson(root: string) {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "docs.json"), "{}\n");
}

const rejectShell = () =>
  Promise.reject(new Error("Reference discovery must not execute shell commands"));

describe("resolveOpenClawReferencePaths", () => {
  it.each([true, false])("requires local reference markers (complete=%s)", async (complete) => {
    const root = await makePackageRoot(complete, complete);
    if (!complete) {
      await fs.mkdir(path.join(root, "docs", "reference", "templates"), { recursive: true });
    }
    expect(await resolveOpenClawReferencePaths({ cwd: root })).toEqual({
      docsPath: complete ? path.join(root, "docs") : null,
      sourcePath: complete ? root : null,
    });
  });
  it.each([
    ["unmounted", null, null],
    ["workspace", "/workspace/docs", "/workspace"],
    ["remote", "/remote/workspace/docs", "/remote/workspace"],
    ["remote-alias", "/remote/workspace/docs", "/remote/workspace"],
    ["read-only", "/agent/docs", "/agent"],
    ["bind", "/reference", null],
    ["shadow", null, "/workspace"],
    ["symlink", null, null],
    ["no-bridge", null, null],
  ])("advertises only readable sandbox references: %s", async (scenario, docsPath, sourcePath) => {
    const root = await makePackageRoot(true, true);
    const workspace = tempDirs.make("openclaw-reference-workspace-");
    if (scenario === "symlink") {
      await fs.symlink(path.join(root, "docs"), path.join(workspace, "docs"), "dir");
    }
    if (scenario === "bind") {
      await writeDocsJson(workspace);
    }
    const workspaceDir =
      scenario === "remote-alias"
        ? path.join(workspace, "checkout")
        : ["workspace", "remote", "shadow"].includes(scenario)
          ? root
          : workspace;
    if (scenario === "remote-alias") {
      await fs.symlink(root, workspaceDir, "dir");
    }
    const sandbox = createSandboxTestContext({
      overrides: {
        workspaceDir,
        agentWorkspaceDir: scenario === "read-only" ? root : workspaceDir,
        workspaceAccess: scenario === "read-only" ? "ro" : "rw",
      },
    });
    sandbox.docker.tmpfs = scenario === "bind" ? ["/workspace/docs"] : [];
    sandbox.docker.binds =
      scenario === "bind"
        ? [`${root}/docs:/reference:ro`]
        : scenario === "shadow"
          ? [`${workspace}:/workspace/docs:ro`]
          : [];
    if (scenario === "remote" || scenario === "remote-alias") {
      sandbox.fsBridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: "/remote/workspace",
          remoteAgentWorkspaceDir: "/remote/agent",
          runRemoteShellScript: rejectShell,
        },
      });
    } else if (scenario !== "no-bridge") {
      const context = { ...sandbox, backend: { runShellCommand: rejectShell } };
      sandbox.fsBridge = createSandboxFsBridge({ sandbox: context });
    }
    const references = await resolveOpenClawReferencePaths({
      workspaceDir: sandbox.workspaceDir,
      cwd: scenario === "remote-alias" ? workspaceDir : root,
      sandbox,
    });
    expect(references).toEqual({ docsPath, sourcePath });
  });
});
