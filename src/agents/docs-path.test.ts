// Covers locating OpenClaw docs and source paths from package roots.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { resolveOpenClawReferencePaths } from "./docs-path.js";

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-docs-path-" });

async function makePackageRoot(): Promise<string> {
  // Tests create minimal package roots so path resolution is checked without
  // depending on this checkout's real docs or git state.
  const root = await suiteTempDirs.make("package");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
  return root;
}

beforeAll(async () => {
  await suiteTempDirs.setup();
});

afterAll(async () => {
  await suiteTempDirs.cleanup();
});

async function writeDocsJson(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "docs.json"), "{}\n");
}

describe("resolveOpenClawDocsPath", () => {
  it("uses the workspace docs directory when it has canonical docs metadata", async () => {
    const root = await makePackageRoot();
    await writeDocsJson(root);

    await expect(resolveOpenClawReferencePaths({ workspaceDir: root })).resolves.toMatchObject({
      docsPath: path.join(root, "docs"),
    });
  });

  it("finds bundled package docs from a nested package path", async () => {
    const root = await makePackageRoot();
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
    const root = await makePackageRoot();
    await fs.mkdir(path.join(root, "docs", "reference", "templates"), { recursive: true });

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toMatchObject({
      docsPath: null,
    });
  });
});

describe("resolveOpenClawSourcePath", () => {
  it("returns the package root only for git checkouts", async () => {
    const root = await makePackageRoot();
    await fs.mkdir(path.join(root, ".git"));

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toMatchObject({
      sourcePath: root,
    });
  });

  it("omits source path for npm-style package installs", async () => {
    // npm installs may contain package files but not source checkout metadata.
    const root = await makePackageRoot();

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toMatchObject({
      sourcePath: null,
    });
  });
});

describe("resolveOpenClawReferencePaths", () => {
  it("returns docs and local source together for git checkouts", async () => {
    const root = await makePackageRoot();
    await writeDocsJson(root);
    await fs.mkdir(path.join(root, ".git"));

    await expect(resolveOpenClawReferencePaths({ cwd: root })).resolves.toEqual({
      docsPath: path.join(root, "docs"),
      sourcePath: root,
    });
  });
});
