// Covers locating OpenClaw docs and source paths from package roots.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawReferencePaths } from "./docs-path.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makePackageRoot(prefix: string): Promise<string> {
  // Tests create minimal package roots so path resolution is checked without
  // depending on this checkout's real docs or git state.
  const root = tempDirs.make(prefix);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
  return root;
}

async function writeDocsJson(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "docs.json"), "{}\n");
}

describe("resolveOpenClawDocsPath", () => {
  it("uses the workspace docs directory when it has canonical docs metadata", async () => {
    const root = await makePackageRoot("openclaw-docs-workspace-");
    await writeDocsJson(root);

    await expect(resolveOpenClawReferencePaths({ workspaceDir: root })).resolves.toMatchObject({
      docsPath: path.join(root, "docs"),
    });
  });

  it("finds bundled package docs from a nested package path", async () => {
    const root = await makePackageRoot("openclaw-docs-package-");
    await writeDocsJson(root);
    const nested = path.join(root, "dist", "agents");
    await fs.mkdir(nested, { recursive: true });

    await expect(resolveOpenClawReferencePaths({ cwd: nested })).resolves.toMatchObject({
      docsPath: path.join(root, "docs"),
    });
  });

  it("does not accept incomplete template-only docs directories", async () => {
    // Template folders alone are not published docs; docs.json is the canonical
    // marker that the path is usable for model reference context.
    const root = await makePackageRoot("openclaw-docs-incomplete-");
    await fs.mkdir(path.join(root, "docs", "reference", "templates"), { recursive: true });

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toMatchObject({
      docsPath: null,
    });
  });
});

describe("resolveOpenClawSourcePath", () => {
  it("omits source path for npm-style package installs", async () => {
    // npm installs may contain package files but not source checkout metadata.
    const root = await makePackageRoot("openclaw-source-npm-");

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toMatchObject({
      sourcePath: null,
    });
  });
});

describe("resolveOpenClawReferencePaths", () => {
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
    const root = await makePackageRoot("openclaw-reference-sandbox-");
    await writeDocsJson(root);
    await fs.mkdir(path.join(root, ".git"));
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
      dockerOverrides: {
        tmpfs: scenario === "bind" ? ["/workspace/docs"] : [],
        binds:
          scenario === "bind"
            ? [`${root}/docs:/reference:ro`]
            : scenario === "shadow"
              ? [`${workspace}:/workspace/docs:ro`]
              : [],
      },
    });
    if (scenario === "remote" || scenario === "remote-alias") {
      sandbox.fsBridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: "/remote/workspace",
          remoteAgentWorkspaceDir: "/remote/agent",
          async runRemoteShellScript() {
            throw new Error("Reference discovery must not execute remote commands");
          },
        },
      });
    } else if (scenario !== "no-bridge") {
      sandbox.fsBridge = createSandboxFsBridge({
        sandbox: {
          ...sandbox,
          backend: {
            async runShellCommand() {
              throw new Error("Reference discovery must not execute sandbox commands");
            },
          },
        },
      });
    }
    const references = await resolveOpenClawReferencePaths({
      workspaceDir: sandbox.workspaceDir,
      cwd: scenario === "remote-alias" ? workspaceDir : root,
      sandbox,
    });
    expect(references).toEqual({ docsPath, sourcePath });
  });

  it("returns docs and local source together for git checkouts", async () => {
    const root = await makePackageRoot("openclaw-reference-git-");
    await writeDocsJson(root);
    await fs.mkdir(path.join(root, ".git"));

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toEqual({
      docsPath: path.join(root, "docs"),
      sourcePath: root,
    });
  });
});
